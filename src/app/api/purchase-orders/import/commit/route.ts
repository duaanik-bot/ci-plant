import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { buildPoNumber, createPurchaseOrderWithLines } from '@/lib/po-create'
import { parseCartonSizeToDims } from '@/lib/die-hub-dimensions'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const newCartonSchema = z.object({
  /** Stable key the line items reference; not stored. */
  clientKey: z.string().min(1),
  cartonName: z.string().min(1),
  cartonSize: z.string().optional().nullable(),
  gsm: z.number().int().positive().optional().nullable(),
  rate: z.number().nonnegative().optional().nullable(),
  gstPct: z.number().int().min(0).max(28).default(12),
  artworkCode: z.string().optional().nullable(),
})

const lineSchema = z.object({
  /**
   * EITHER an existing Carton id OR a clientKey from newCartons[]. The route
   * resolves clientKey → newly-created Carton id inside the transaction.
   */
  cartonId: z.string().uuid().nullable().optional(),
  newCartonClientKey: z.string().optional().nullable(),
  cartonName: z.string().min(1),
  cartonSize: z.string().optional().nullable(),
  quantity: z.number().int().positive(),
  artworkCode: z.string().optional().nullable(),
  rate: z.number().nonnegative().optional().nullable(),
  gsm: z.number().int().positive().optional().nullable(),
  gstPct: z.number().int().min(0).max(28).default(12),
  remarks: z.string().optional().nullable(),
})

const commitSchema = z.object({
  customerId: z.string().uuid(),
  poNumber: z.string().min(1).max(100).optional().nullable(),
  poDate: z.string().min(1),
  deliveryRequiredBy: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
  newCartons: z.array(newCartonSchema).default([]),
  lineItems: z.array(lineSchema).min(1),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const parsed = commitSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path && !fields[path]) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data

  const customer = await db.customer.findUnique({
    where: { id: data.customerId },
    select: { id: true },
  })
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  // Resolve PO number — manual override if provided, else auto-generate.
  const rawPoNumber = data.poNumber?.trim()
  let poNumber: string
  if (rawPoNumber) {
    const existing = await db.purchaseOrder.findUnique({
      where: { poNumber: rawPoNumber },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'PO number already exists', fields: { poNumber: 'This PO number is already in use' } },
        { status: 400 },
      )
    }
    poNumber = rawPoNumber
  } else {
    const lastPo = await db.purchaseOrder.findFirst({
      orderBy: { poNumber: 'desc' },
      select: { poNumber: true },
    })
    poNumber = buildPoNumber(lastPo?.poNumber ?? null)
  }

  // Validate every line either has a real cartonId or a known clientKey.
  const newCartonKeys = new Set(data.newCartons.map((c) => c.clientKey))
  const referencedExistingIds = data.lineItems
    .map((l) => l.cartonId)
    .filter((id): id is string => Boolean(id))
  const existingValid = referencedExistingIds.length
    ? new Set(
        (
          await db.carton.findMany({
            where: { id: { in: referencedExistingIds }, customerId: data.customerId },
            select: { id: true },
          })
        ).map((c) => c.id),
      )
    : new Set<string>()

  for (const li of data.lineItems) {
    const hasExisting = li.cartonId && existingValid.has(li.cartonId)
    const hasNew = li.newCartonClientKey && newCartonKeys.has(li.newCartonClientKey)
    if (!hasExisting && !hasNew) {
      return NextResponse.json(
        {
          error:
            'Every line item must reference an existing Carton or a new-Carton clientKey from newCartons[].',
        },
        { status: 400 },
      )
    }
  }

  let created
  try {
    created = await db.$transaction(async (tx) => {
      // 1. Create any new Cartons proposed by the import, mapping clientKey → real id.
      const clientKeyToId = new Map<string, string>()
      for (const proposal of data.newCartons) {
        const dims = parseCartonSizeToDims(proposal.cartonSize)
        const newCarton = await tx.carton.create({
          data: {
            cartonName: proposal.cartonName,
            customerId: data.customerId,
            gsm: proposal.gsm ?? null,
            rate: proposal.rate ?? null,
            gstPct: proposal.gstPct,
            artworkCode: proposal.artworkCode ?? null,
            finishedLength: dims?.l ?? null,
            finishedWidth: dims?.w ?? null,
            finishedHeight: dims?.h ?? null,
          },
          select: { id: true },
        })
        clientKeyToId.set(proposal.clientKey, newCarton.id)
      }

      // 2. Build the line-items payload with resolved Carton ids.
      const resolvedLines = data.lineItems.map((li) => {
        const cartonId =
          (li.cartonId && existingValid.has(li.cartonId) ? li.cartonId : null) ||
          (li.newCartonClientKey ? clientKeyToId.get(li.newCartonClientKey) ?? null : null)
        return {
          cartonId,
          cartonName: li.cartonName,
          cartonSize: li.cartonSize ?? null,
          quantity: li.quantity,
          artworkCode: li.artworkCode ?? null,
          rate: li.rate ?? null,
          gsm: li.gsm ?? null,
          gstPct: li.gstPct,
          remarks: li.remarks ?? null,
        }
      })

      return await createPurchaseOrderWithLines(tx, {
        poNumber,
        customerId: data.customerId,
        poDate: new Date(data.poDate),
        deliveryRequiredBy: data.deliveryRequiredBy?.trim()
          ? new Date(data.deliveryRequiredBy.trim())
          : null,
        remarks: data.remarks ?? null,
        status: 'draft',
        isPriority: false,
        createdBy: user.id,
        lineItems: resolvedLines,
      })
    })
  } catch (err) {
    console.error('[POST /api/purchase-orders/import/commit] DB error:', err)
    const message = err instanceof Error ? err.message : 'Database error while saving PO'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  await createAuditLog({
    userId: user.id,
    action: 'INSERT',
    tableName: 'purchase_orders',
    recordId: created.id,
    newValue: {
      poNumber,
      customerId: created.customerId,
      source: 'pdf_import',
      actorLabel: 'Anik Dua',
    },
  })

  return NextResponse.json({ id: created.id, poNumber: created.poNumber }, { status: 201 })
}
