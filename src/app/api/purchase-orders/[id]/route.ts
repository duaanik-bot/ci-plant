import { NextRequest, NextResponse } from 'next/server'
import { PastingStyle } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import { z } from 'zod'
import { purchaseOrderSchema } from '@/lib/validations'
import { syncMaterialRequirementsForPurchaseOrder } from '@/lib/material-requirement-sync'
import { withDefaultPrePressAuditLead } from '@/lib/pre-press-defaults'
import { isPlanningFactsLocked, mergeSpecRespectingPlanningLock } from '@/lib/planning-facts-lock'

export const dynamic = 'force-dynamic'

const lineItemUpdateSchema = purchaseOrderSchema.shape.lineItems.element
  .omit({ rate: true })
  .extend({
    id: z.string().uuid().optional(),
    rate: z.number().nonnegative().optional().nullable(),
    cartonId: z.string().uuid().optional().nullable(),
    cartonSize: z.string().optional(),
    artworkCode: z.string().optional().nullable(),
    backPrint: z.string().optional(),
    gstPct: z.number().int().min(0).max(28).default(5),
    coatingType: z.string().optional(),
    otherCoating: z.string().optional(),
    embossingLeafing: z.string().optional(),
    paperType: z.string().optional(),
    dyeId: z.string().optional().nullable(),
    dieMasterId: z.string().optional().nullable(),
    remarks: z.string().optional(),
    setNumber: z.string().optional(),
    planningStatus: z.string().optional(),
    toolingLocked: z.boolean().optional(),
    lineDieType: z.string().optional().nullable(),
    dimLengthMm: z.coerce.number().optional().nullable(),
    dimWidthMm: z.coerce.number().optional().nullable(),
    dimHeightMm: z.coerce.number().optional().nullable(),
    materialProcurementStatus: z.string().optional(),
    directorPriority: z.boolean().optional(),
    shadeCardId: z.string().uuid().optional().nullable(),
    specOverrides: z
      .object({
        wastagePct: z.number().optional(),
        boardGrade: z.string().optional(),
        foilType: z.string().optional(),
        pastingStyle: z.nativeEnum(PastingStyle).optional(),
        pastingType: z.string().optional(),
      })
      .passthrough()
      .optional()
      .nullable(),
  })

const updateSchema = purchaseOrderSchema.partial().omit({
  deliveryRequiredBy: true,
  paymentTerms: true,
  priority: true,
  specialInstructions: true,
  lineItems: true,
}).extend({
  poNumber: z.string().min(1).max(100).optional(),
  poDate: z.string().optional(),
  remarks: z.string().optional(),
  status: z.string().optional(),
  isPriority: z.boolean().optional(),
  deliveryRequiredBy: z.string().optional().nullable(),
  lineItems: z.array(lineItemUpdateSchema).optional(),
  /** Spotlight drawer — audit trail uses director verification label */
  industrialVerification: z.boolean().optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true } },
      lineItems: { include: { materialQueue: true } },
    },
  })

  if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 })

  return NextResponse.json(po)
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const existing = await db.purchaseOrder.findUnique({
    where: { id },
    include: { lineItems: true },
  })
  if (!existing) return NextResponse.json({ error: 'PO not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    lineItems: Array.isArray(body.lineItems)
      ? body.lineItems.map((li: any) => ({
          ...li,
          quantity: li.quantity != null ? Number(li.quantity) : undefined,
          rate: li.rate != null ? Number(li.rate) : undefined,
          gsm: li.gsm != null ? Number(li.gsm) : undefined,
          gstPct: li.gstPct != null ? Number(li.gstPct) : undefined,
        }))
      : undefined,
  })

  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data

  /** After "Release to Planning", only safe fields can change (read-only PO + lines). */
  if (existing.status === 'sent_to_planning') {
    if (data.lineItems !== undefined) {
      return NextResponse.json(
        {
          error:
            'This PO was sent to Planning and is locked. Lines cannot be edited here. Contact Planning for changes.',
          code: 'PO_LOCKED',
        },
        { status: 409 },
      )
    }
    const attempted = Object.entries(data).filter(([, v]) => v !== undefined).map(([k]) => k)
    const allowed = new Set([
      'remarks',
      'isPriority',
      'deliveryRequiredBy',
      'status',
      'industrialVerification',
    ])
    const blocked = attempted.filter((k) => !allowed.has(k))
    if (blocked.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot change ${blocked.join(', ')} after release to Planning.`,
          code: 'PO_LOCKED',
        },
        { status: 409 },
      )
    }
    if (data.status != null && data.status !== 'closed' && data.status !== 'sent_to_planning') {
      return NextResponse.json(
        { error: 'Only close (status closed) is allowed after release, for this PO.', code: 'PO_LOCKED' },
        { status: 409 },
      )
    }
  }

  // If poNumber is being changed, check it's not already taken by another PO
  if (data.poNumber && data.poNumber !== existing.poNumber) {
    const conflict = await db.purchaseOrder.findUnique({
      where: { poNumber: data.poNumber },
      select: { id: true },
    })
    if (conflict && conflict.id !== id) {
      return NextResponse.json(
        { error: 'PO number already exists', fields: { poNumber: 'This PO number is already in use' } },
        { status: 400 }
      )
    }
  }

  const updated = await db.$transaction(async (tx) => {
    const header = await tx.purchaseOrder.update({
      where: { id },
      data: {
        ...(data.poNumber ? { poNumber: data.poNumber } : {}),
        ...(data.customerId ? { customerId: data.customerId } : {}),
        ...(data.poDate ? { poDate: new Date(data.poDate) } : {}),
        ...(data.remarks !== undefined ? { remarks: data.remarks || null } : {}),
        ...(data.status ? { status: data.status } : {}),
        ...(data.isPriority !== undefined ? { isPriority: data.isPriority } : {}),
        ...(data.deliveryRequiredBy !== undefined
          ? {
              deliveryRequiredBy: data.deliveryRequiredBy?.trim()
                ? new Date(data.deliveryRequiredBy.trim())
                : null,
            }
          : {}),
      },
    })

    // Planning-first: keep line planningStatus as `pending` until Planning Decision Layer saves (no auto-jump to AW).

    if (data.lineItems) {
      const existingLines = existing.lineItems
      const existingById = new Map(existingLines.map((x) => [x.id, x]))
      const incomingIdSet = new Set(
        data.lineItems
          .map((li) => li.id)
          .filter((x): x is string => typeof x === 'string' && x.length > 0),
      )
      const toRemove = existingLines.filter((e) => !incomingIdSet.has(e.id)).map((e) => e.id)
      if (toRemove.length > 0) {
        await tx.poLineItem.deleteMany({
          where: { poId: id, id: { in: toRemove } },
        })
      }

      for (const li of data.lineItems) {
        const prev = li.id ? existingById.get(li.id) : undefined
        const rawSpec =
          li.specOverrides && Object.keys(li.specOverrides).length > 0
            ? (li.specOverrides as Record<string, unknown>)
            : prev
              ? (prev.specOverrides as Record<string, unknown> | null)
              : null
        const mergedForLock =
          prev
            ? mergeSpecRespectingPlanningLock(
                prev.specOverrides as Record<string, unknown> | null,
                rawSpec ?? {},
              )
            : rawSpec ?? {}
        const specOverrides = withDefaultPrePressAuditLead(mergedForLock) as object

        const locked = prev ? isPlanningFactsLocked(prev.specOverrides as Record<string, unknown> | null) : false
        const setNumberForRow =
          locked ? (prev?.setNumber ?? null) : li.setNumber || null

        const row = {
          poId: id,
          cartonId: li.cartonId || null,
          cartonName: li.cartonName,
          cartonSize: li.cartonSize || null,
          quantity: li.quantity,
          artworkCode: li.artworkCode || null,
          backPrint: li.backPrint || 'No',
          rate: li.rate != null ? li.rate : null,
          gsm: li.gsm ?? null,
          gstPct: li.gstPct,
          coatingType: li.coatingType || null,
          otherCoating: li.otherCoating || null,
          embossingLeafing: li.embossingLeafing || null,
          paperType: li.paperType || null,
          dyeId: li.dyeId !== undefined ? li.dyeId : prev?.dyeId ?? null,
          remarks: li.remarks || null,
          setNumber: setNumberForRow,
          planningStatus: li.planningStatus ?? prev?.planningStatus ?? 'pending',
          specOverrides,
          dieMasterId:
            li.dieMasterId !== undefined ? li.dieMasterId : prev?.dieMasterId ?? null,
          toolingLocked: li.toolingLocked ?? prev?.toolingLocked ?? true,
          lineDieType: li.lineDieType !== undefined ? li.lineDieType : prev?.lineDieType ?? null,
          dimLengthMm: li.dimLengthMm !== undefined ? li.dimLengthMm : prev?.dimLengthMm ?? null,
          dimWidthMm: li.dimWidthMm !== undefined ? li.dimWidthMm : prev?.dimWidthMm ?? null,
          dimHeightMm: li.dimHeightMm !== undefined ? li.dimHeightMm : prev?.dimHeightMm ?? null,
          materialProcurementStatus:
            li.materialProcurementStatus ??
            prev?.materialProcurementStatus ??
            'pending',
          directorPriority:
            li.directorPriority !== undefined
              ? li.directorPriority
              : (prev?.directorPriority ?? false),
          shadeCardId:
            li.shadeCardId !== undefined ? li.shadeCardId : prev?.shadeCardId ?? null,
        }

        if (li.id && existingById.has(li.id)) {
          await tx.poLineItem.update({
            where: { id: li.id },
            data: row,
          })
        } else {
          await tx.poLineItem.create({
            data: row,
          })
        }
      }
    }

    return header
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_orders',
    recordId: id,
    newValue: { ...data, actorLabel: 'Anik Dua' },
  })

  if (
    data.industrialVerification === true &&
    data.status &&
    data.status !== existing.status
  ) {
    await logIndustrialStatusChange({
      userId: user!.id ?? '',
      action: 'po_status_drawer_verified',
      module: 'CustomerPO',
      recordId: id,
      operatorLabel: 'Verified by Anik Dua',
      payload: { fromStatus: existing.status, toStatus: data.status },
    })
  }

  return NextResponse.json(updated)
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  try {
    const existing = await db.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, poNumber: true, status: true },
    })
    if (!existing) return NextResponse.json({ error: 'PO not found' }, { status: 404 })
    if (existing.status === 'sent_to_planning') {
      return NextResponse.json(
        { error: 'Cannot delete a PO that was sent to Planning. Close it instead.', code: 'PO_LOCKED' },
        { status: 409 },
      )
    }

    await db.$transaction(async (tx) => {
      await tx.poLineItem.deleteMany({ where: { poId: id } })
      await tx.purchaseOrder.delete({ where: { id } })
    })

    await createAuditLog({
      userId: user!.id,
      action: 'DELETE',
      tableName: 'purchase_orders',
      recordId: id,
      oldValue: { poNumber: existing.poNumber },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete PO'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
