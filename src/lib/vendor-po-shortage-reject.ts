import type { PrismaClient } from '@prisma/client'

const EPS = 1e-3

/** True if `rejectKg` matches at least one completed GRN line's rejected tranche on this PO. */
export async function vendorPoHasReceiptRejectKg(
  db: PrismaClient,
  vendorPoId: string,
  rejectKg: number,
): Promise<boolean> {
  if (!Number.isFinite(rejectKg) || rejectKg <= 0) return false
  const rows = await db.vendorMaterialReceipt.findMany({
    where: { vendorPoId, qtyRejected: { not: null } },
    select: { qtyRejected: true },
  })
  return rows.some((r) => {
    const q = r.qtyRejected != null ? Number(r.qtyRejected) : 0
    return Math.abs(q - rejectKg) <= EPS
  })
}
