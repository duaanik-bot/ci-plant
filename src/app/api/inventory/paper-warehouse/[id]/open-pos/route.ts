import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: materialId } = await context.params

  // Path 1: PR-linked POs
  const prLinked = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      isShortClosed: false,
      status: { not: 'received' },
      requisitionLinks: {
        some: { pr: { materialId } },
      },
    },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { totalWeightKg: true } },
      requisitionLinks: { select: { purchaseRequisitionId: true } },
    },
  })

  // Path 2: Direct fast-track POs
  const direct = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      materialId,
      isShortClosed: false,
      status: { not: 'received' },
    },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { totalWeightKg: true } },
      requisitionLinks: { select: { purchaseRequisitionId: true } },
    },
  })

  // Merge and deduplicate by PO id
  const seen = new Set<string>()
  const all = [...prLinked, ...direct].filter((po) => {
    if (seen.has(po.id)) return false
    seen.add(po.id)
    return true
  })

  const result = all.map((po) => {
    const orderedKg = po.lines.reduce((s, l) => s + Number(l.totalWeightKg), 0)
    const receivedKg = Number(po.totalReceivedKg)
    return {
      id: po.id,
      poNumber: po.poNumber,
      vendorName: po.supplier.name,
      orderedKg,
      receivedKg,
      pendingKg: Math.max(0, orderedKg - receivedKg),
      requiredDeliveryDate: po.requiredDeliveryDate?.toISOString().slice(0, 10) ?? null,
      status: po.status,
      logisticsStatus: po.logisticsStatus,
      linkedPrIds: po.requisitionLinks.map((l) => l.purchaseRequisitionId),
    }
  })

  return NextResponse.json(result)
}
