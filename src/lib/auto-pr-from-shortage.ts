import type { Prisma, PurchaseRequisition } from '@prisma/client'

const OPEN_PR_STATUSES = ['draft', 'pending', 'approved'] as const

/**
 * Create a draft PurchaseRequisition for a material if shortage > 0
 * and no "open" PR already exists for that material. Returns null when
 * shortage is zero or dedupe matches an existing open PR.
 *
 * "Open" = status in {draft, pending, approved}. {converted_to_po,
 * received, rejected} do NOT count as open.
 */
export async function maybeCreateDraftPrForShortage(
  materialId: string,
  shortage: number,
  tx: Prisma.TransactionClient,
): Promise<PurchaseRequisition | null> {
  if (shortage <= 0) return null

  const existing = await tx.purchaseRequisition.findFirst({
    where: {
      materialId,
      status: { in: OPEN_PR_STATUSES as unknown as string[] },
    },
    select: { id: true },
  })
  if (existing) return null

  const material = await tx.inventory.findUnique({
    where: { id: materialId },
    select: {
      boardType: true,
      gsm: true,
      sheetLength: true,
      sheetWidth: true,
      weightedAvgCost: true,
    },
  })
  if (!material) return null

  const sizeLabel =
    material.sheetLength != null && material.sheetWidth != null
      ? `${Number(material.sheetLength)} x ${Number(material.sheetWidth)}`
      : null

  return tx.purchaseRequisition.create({
    data: {
      materialId,
      qtyRequired: shortage,
      estimatedValue: shortage * Number(material.weightedAvgCost || 0),
      triggerReason: 'auto_shortage',
      status: 'draft',
      raisedBy: null,
      boardType: material.boardType,
      sizeLabel,
      gsm: material.gsm,
    },
  })
}
