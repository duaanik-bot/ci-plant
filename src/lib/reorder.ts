// Auto-create Purchase Requisition when qty_available <= reorder_point

import { db } from './db'

const SYSTEM_RAISED = 'system'

export async function checkReorderPoints(materialId: string): Promise<boolean> {
  const inv = await db.inventory.findUnique({
    where: { id: materialId },
    include: { supplier: true },
  })
  if (!inv || !inv.active) return false

  const qtyAvailable = Number(inv.qtyAvailable)
  const reorderPoint = Number(inv.reorderPoint)
  if (reorderPoint <= 0 || qtyAvailable > reorderPoint) return false

  const openPr = await db.purchaseRequisition.findFirst({
    where: {
      materialId,
      status: { in: ['pending', 'approved'] },
    },
  })
  if (openPr) return false

  const qtyRequired = reorderPoint - qtyAvailable + Number(inv.safetyStock || 0)
  const estimatedValue = qtyRequired * Number(inv.weightedAvgCost || 0)

  await db.purchaseRequisition.create({
    data: {
      materialId,
      qtyRequired: Math.ceil(qtyRequired),
      estimatedValue,
      triggerReason: `qty_available (${qtyAvailable}) <= reorder_point (${reorderPoint})`,
      status: 'pending',
      raisedBy: SYSTEM_RAISED,
      supplierId: inv.supplierId ?? undefined,
    },
  })

  return true
}
