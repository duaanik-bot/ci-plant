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
  const shortages = ids.length
    ? await db.materialShortage.findMany({
        where: { purchaseReqId: { in: ids } },
        select: {
          purchaseReqId: true,
          jobCardId: true,
          planningId: true,
          requiredByDate: true,
          remainingQty: true,
          shortageQty: true,
        },
      })
    : []

  const jobIds = Array.from(new Set(shortages.map((s) => s.jobCardId).filter((v): v is string => !!v)))
  const jobCards = jobIds.length
    ? await db.productionJobCard.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, jobCardNumber: true },
      })
    : []
  const jobMap = new Map(jobCards.map((j) => [j.id, j]))
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

  const poRefs = Array.from(
    new Set(list.filter((r) => r.status === 'converted_to_po' && r.poReference).map((r) => r.poReference as string)),
  )
  const pos = poRefs.length
    ? await db.vendorMaterialPurchaseOrder.findMany({
        where: { id: { in: poRefs } },
        select: {
          id: true,
          poNumber: true,
          status: true,
          requiredDeliveryDate: true,
          totalReceivedKg: true,
          supplier: { select: { name: true } },
          lines: { select: { totalWeightKg: true } },
        },
      })
    : []
  const poById = new Map(pos.map((p) => [p.id, p]))

  return NextResponse.json(
    list.map((r) => {
      const po = r.status === 'converted_to_po' && r.poReference ? poById.get(r.poReference) : undefined
      const orderedQty = po ? po.lines.reduce((s, l) => s + Number(l.totalWeightKg), 0) : null
      const receivedQty = po ? Number(po.totalReceivedKg) : null
      return {
        linkedShortages: shortages
          .filter((s) => s.purchaseReqId === r.id)
          .map((s) => ({
            jobCardId: s.jobCardId ?? null,
            jobCardNumber: s.jobCardId ? (jobMap.get(s.jobCardId)?.jobCardNumber ?? null) : null,
            planningId: s.planningId,
            requiredByDate: s.requiredByDate ? s.requiredByDate.toISOString() : null,
            pendingShortage: Number(s.remainingQty),
            requiredQty: Number(s.shortageQty),
          })),
        ...r,
        requiredByDate: r.requiredByDate ? r.requiredByDate.toISOString() : null,
        uiStage: dbStatusToUiStage(r.status),
        monitoring: po
          ? {
              poNumber: po.poNumber,
              vendorName: po.supplier?.name ?? null,
              status: po.status,
              eta: po.requiredDeliveryDate ? po.requiredDeliveryDate.toISOString() : null,
              orderedQty,
              receivedQty,
              pendingQty: orderedQty != null && receivedQty != null ? Math.max(0, orderedQty - receivedQty) : null,
            }
          : null,
        orderedAt:
          orderedAtById.get(r.id) ??
          (r.status === 'converted_to_po' || r.status === 'received' || r.status === 'ordered'
            ? (r.approvedAt ?? r.createdAt).toISOString()
            : null),
        receivedAt:
          receivedAtById.get(r.id) ??
          (r.status === 'received' ? (r.approvedAt ?? r.createdAt).toISOString() : null),
      }
    }),
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
