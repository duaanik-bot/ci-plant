import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const pos = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      isShortClosed: false,
      status: { not: 'received' },
    },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { totalWeightKg: true } },
      material: { select: { materialCode: true } },
      requisitionLinks: {
        select: {
          purchaseRequisitionId: true,
          pr: { select: { materialId: true, material: { select: { materialCode: true } } } },
        },
        take: 1,
      },
    },
    orderBy: { requiredDeliveryDate: 'asc' },
  })

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const result = pos.map((po) => {
    const orderedKg = po.lines.reduce((s, l) => s + Number(l.totalWeightKg), 0)
    const receivedKg = Number(po.totalReceivedKg)
    const pendingKg = Math.max(0, orderedKg - receivedKg)

    // Resolve materialCode: direct FK first, then first linked PR's material
    const materialCode =
      po.material?.materialCode ??
      po.requisitionLinks[0]?.pr?.material?.materialCode ??
      null

    const daysOverdue = po.requiredDeliveryDate
      ? Math.floor((today.getTime() - po.requiredDeliveryDate.getTime()) / 86_400_000)
      : null

    return {
      id: po.id,
      poNumber: po.poNumber,
      vendorName: po.supplier.name,
      materialCode,
      orderedKg,
      receivedKg,
      pendingKg,
      requiredDeliveryDate: po.requiredDeliveryDate?.toISOString().slice(0, 10) ?? null,
      status: po.status,
      logisticsStatus: po.logisticsStatus,
      daysOverdue,
      linkedPrIds: po.requisitionLinks.map((l) => l.purchaseRequisitionId),
    }
  })

  return NextResponse.json(result)
}
