import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'
import {
  assertPlanningFactsUnchanged,
  userCanRevisePlanningDecision,
} from '@/lib/planning-facts-lock'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  setNumber: z.string().optional().nullable(),
  artworkCode: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
  planningStatus: z.string().optional(),
  specOverrides: z.any().optional(),
  /** When planning facts are locked, authorised Planning users must set this to change UPS / set / gang / designer. */
  planningDecisionRevision: z.boolean().optional(),
  dieMasterId: z.string().uuid().optional().nullable(),
  toolingLocked: z.boolean().optional(),
  lineDieType: z.string().optional().nullable(),
  dimLengthMm: z.coerce.number().optional().nullable(),
  dimWidthMm: z.coerce.number().optional().nullable(),
  dimHeightMm: z.coerce.number().optional().nullable(),
  directorHold: z.boolean().optional(),
  /** Line fields — allowed from Planning while PO is locked to PO screen edits. */
  cartonName: z.string().min(1).optional(),
  cartonSize: z.string().optional().nullable(),
  quantity: z.coerce.number().int().positive().optional(),
  rate: z.coerce.number().nonnegative().optional().nullable(),
  coatingType: z.string().optional().nullable(),
  otherCoating: z.string().optional().nullable(),
  embossingLeafing: z.string().optional().nullable(),
  paperType: z.string().optional().nullable(),
  gsm: z.coerce.number().int().optional().nullable(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const li = await db.poLineItem.findUnique({
    where: { id },
    include: {
      po: { include: { customer: true } },
    },
  })
  if (!li) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })
  return NextResponse.json(li)
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.poLineItem.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data

  const existingSpec = (existing.specOverrides as Record<string, unknown> | null) || {}
  const mergedSpec =
    data.specOverrides !== undefined
      ? { ...existingSpec, ...(data.specOverrides as Record<string, unknown>) }
      : existingSpec
  const mergedSetNumber =
    data.setNumber !== undefined ? data.setNumber : (existing.setNumber ?? null)

  const touchedKeys =
    data.specOverrides !== undefined && typeof data.specOverrides === 'object'
      ? new Set(Object.keys(data.specOverrides as object))
      : undefined

  const viol = assertPlanningFactsUnchanged({
    existingSpec,
    mergedSpec,
    existingSetNumber: existing.setNumber,
    mergedSetNumber,
    touchedSpecKeys: touchedKeys,
  })

  if (viol.ok === false) {
    if (data.planningDecisionRevision && userCanRevisePlanningDecision(user!)) {
      // allow mutation
    } else if (data.planningDecisionRevision && !userCanRevisePlanningDecision(user!)) {
      return NextResponse.json(
        {
          error: 'Forbidden — planning revision requires md / operations_head / production_manager (or full production permission).',
          field: 'planningDecisionRevision',
        },
        { status: 403 },
      )
    } else {
      return NextResponse.json(
        { error: viol.message, field: viol.field },
        { status: 403 },
      )
    }
  }

  const updated = await db.poLineItem.update({
    where: { id },
    data: {
      ...(data.setNumber !== undefined ? { setNumber: data.setNumber || null } : {}),
      ...(data.artworkCode !== undefined ? { artworkCode: data.artworkCode || null } : {}),
      ...(data.remarks !== undefined ? { remarks: data.remarks || null } : {}),
      ...(data.planningStatus !== undefined ? { planningStatus: data.planningStatus } : {}),
      ...(data.specOverrides !== undefined ? { specOverrides: mergedSpec as object } : {}),
      ...(data.dieMasterId !== undefined
        ? { dieMasterId: data.dieMasterId || null }
        : {}),
      ...(data.toolingLocked !== undefined ? { toolingLocked: data.toolingLocked } : {}),
      ...(data.lineDieType !== undefined ? { lineDieType: data.lineDieType || null } : {}),
      ...(data.dimLengthMm !== undefined ? { dimLengthMm: data.dimLengthMm } : {}),
      ...(data.dimWidthMm !== undefined ? { dimWidthMm: data.dimWidthMm } : {}),
      ...(data.dimHeightMm !== undefined ? { dimHeightMm: data.dimHeightMm } : {}),
      ...(data.directorHold !== undefined ? { directorHold: data.directorHold } : {}),
      ...(data.cartonName !== undefined ? { cartonName: data.cartonName.trim() } : {}),
      ...(data.cartonSize !== undefined ? { cartonSize: data.cartonSize || null } : {}),
      ...(data.quantity !== undefined ? { quantity: data.quantity } : {}),
      ...(data.rate !== undefined
        ? { rate: data.rate != null ? new Prisma.Decimal(data.rate) : null }
        : {}),
      ...(data.coatingType !== undefined ? { coatingType: data.coatingType || null } : {}),
      ...(data.otherCoating !== undefined ? { otherCoating: data.otherCoating || null } : {}),
      ...(data.embossingLeafing !== undefined ? { embossingLeafing: data.embossingLeafing || null } : {}),
      ...(data.paperType !== undefined ? { paperType: data.paperType || null } : {}),
      ...(data.gsm !== undefined ? { gsm: data.gsm } : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: id,
    newValue: data,
  })

  return NextResponse.json(updated)
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.poLineItem.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  try {
    await db.poLineItem.delete({ where: { id } })
  } catch {
    return NextResponse.json(
      { error: 'Line cannot be deleted because it is linked to downstream records.' },
      { status: 409 },
    )
  }

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'po_line_items',
    recordId: id,
    oldValue: existing,
  })

  return NextResponse.json({ ok: true })
}

