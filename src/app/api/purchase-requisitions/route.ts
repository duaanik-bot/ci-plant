import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'
import { dbStatusToUiStage, mapFilterToDbStatuses } from '@/lib/purchase-requisition-status'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  materialId: z.string().uuid(),
  qtyRequired: z.number().positive(),
  estimatedValue: z.number().min(0).optional(),
  triggerReason: z.string().min(1),
  supplierId: z.string().uuid().optional(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const stage = searchParams.get('stage')
  const materialId = searchParams.get('materialId')

  const where: { status?: string | { in: string[] }; materialId?: string } = {}
  const mappedStatuses = mapFilterToDbStatuses(stage || status)
  if (mappedStatuses?.length === 1) where.status = mappedStatuses[0]!
  else if (mappedStatuses && mappedStatuses.length > 1) where.status = { in: mappedStatuses }
  if (materialId) where.materialId = materialId

  const list = await db.purchaseRequisition.findMany({
    where,
    orderBy: { raisedAt: 'desc' },
    include: {
      material: { select: { materialCode: true, description: true, unit: true } },
    },
  })

  const ids = list.map((r) => r.id)
  const audits = ids.length
    ? await db.auditLog.findMany({
        where: {
          tableName: 'purchase_requisitions',
          recordId: { in: ids },
          action: 'UPDATE',
        },
        orderBy: { timestamp: 'asc' },
        select: { recordId: true, timestamp: true, newValue: true },
      })
    : []

  const orderedAtById = new Map<string, string>()
  const receivedAtById = new Map<string, string>()
  for (const a of audits) {
    const rid = a.recordId || ''
    if (!rid) continue
    const nv = (a.newValue as Record<string, unknown> | null) || {}
    const st = typeof nv.status === 'string' ? nv.status : ''
    if (st === 'converted_to_po' && !orderedAtById.has(rid)) orderedAtById.set(rid, a.timestamp.toISOString())
    if (st === 'received' && !receivedAtById.has(rid)) receivedAtById.set(rid, a.timestamp.toISOString())
  }

  return NextResponse.json(
    list.map((r) => ({
      ...r,
      uiStage: dbStatusToUiStage(r.status),
      orderedAt:
        orderedAtById.get(r.id) ??
        (r.status === 'converted_to_po' || r.status === 'received' ? (r.approvedAt ?? r.createdAt).toISOString() : null),
      receivedAt:
        receivedAtById.get(r.id) ??
        (r.status === 'received' ? (r.approvedAt ?? r.createdAt).toISOString() : null),
    })),
  )
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = createSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { materialId, qtyRequired, triggerReason, supplierId } = parsed.data
  const estimatedValue = parsed.data.estimatedValue ?? 0

  const inv = await db.inventory.findUnique({ where: { id: materialId } })
  if (!inv) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const pr = await db.purchaseRequisition.create({
    data: {
      materialId,
      qtyRequired,
      estimatedValue,
      triggerReason,
      raisedBy: user!.id,
      supplierId: supplierId ?? inv.supplierId ?? undefined,
    },
    include: {
      material: { select: { materialCode: true, description: true, unit: true } },
    },
  })

  return NextResponse.json(pr)
}
