import type { Prisma, PrismaClient } from '@prisma/client'
import { receiptAccruedPayableInr, receiptUsableKg } from '@/lib/grn-receipt-qc'
import { isVendorPoPostDispatchReceiving } from '@/lib/vendor-po-post-dispatch'
import { invoiceRateFromVendorLines, orderedGsmFromVendorLines } from '@/lib/vendor-po-ordered-gsm'

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function sumOrderedKgFromLines(
  lines: { totalWeightKg: unknown }[],
): number {
  let o = 0
  for (const li of lines) {
    o += Number(li.totalWeightKg)
  }
  return round6(o)
}

/** After mutating receipts or QC, recompute gross + usable kg, accrued payable, and PO status. */
export async function syncVendorPoReceiptAggregate(
  db: PrismaClient | Prisma.TransactionClient,
  vendorPoId: string,
): Promise<{
  totalReceivedKg: number
  totalUsableReceivedKg: number
  accruedReceiptPayableInr: number
  orderedKg: number
  status: string
}> {
  const po = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id: vendorPoId },
    include: { lines: { select: { totalWeightKg: true, gsm: true, ratePerKg: true } } },
  })
  if (!po) throw new Error('Vendor PO not found')

  const receipts = await db.vendorMaterialReceipt.findMany({
    where: { vendorPoId },
    select: {
      receivedQty: true,
      qcStatus: true,
      qcPerformedAt: true,
      qtyAcceptedStandard: true,
      qtyAcceptedPenalty: true,
      qtyRejected: true,
      qcActualGsm: true,
      qcPenaltyRecommendedInr: true,
    },
  })

  const grossAgg = await db.vendorMaterialReceipt.aggregate({
    where: { vendorPoId },
    _sum: { receivedQty: true },
  })
  const totalReceivedKg = round6(Number(grossAgg._sum.receivedQty ?? 0))

  const orderedGsm = orderedGsmFromVendorLines(po.lines)
  const invoiceRate = invoiceRateFromVendorLines(po.lines) ?? 0

  let totalUsableReceivedKg = 0
  let accruedReceiptPayableInr = 0
  for (const r of receipts) {
    totalUsableReceivedKg += receiptUsableKg(r)
    accruedReceiptPayableInr += receiptAccruedPayableInr(r, invoiceRate, orderedGsm)
  }
  totalUsableReceivedKg = round6(totalUsableReceivedKg)
  accruedReceiptPayableInr = round2(accruedReceiptPayableInr)

  const orderedKg = sumOrderedKgFromLines(po.lines)

  let nextStatus = po.status
  if (po.status === 'closed' || po.isShortClosed) {
    await db.vendorMaterialPurchaseOrder.update({
      where: { id: vendorPoId },
      data: { totalReceivedKg, totalUsableReceivedKg, accruedReceiptPayableInr },
    })
    return { totalReceivedKg, totalUsableReceivedKg, accruedReceiptPayableInr, orderedKg, status: po.status }
  }

  if (!isVendorPoPostDispatchReceiving(po.status)) {
    await db.vendorMaterialPurchaseOrder.update({
      where: { id: vendorPoId },
      data: { totalReceivedKg, totalUsableReceivedKg, accruedReceiptPayableInr },
    })
    return { totalReceivedKg, totalUsableReceivedKg, accruedReceiptPayableInr, orderedKg, status: po.status }
  }

  if (totalUsableReceivedKg <= 0) {
    nextStatus = 'dispatched'
  } else if (totalUsableReceivedKg < orderedKg) {
    nextStatus = 'partially_received'
  } else {
    nextStatus = 'fully_received'
  }

  await db.vendorMaterialPurchaseOrder.update({
    where: { id: vendorPoId },
    data: { totalReceivedKg, totalUsableReceivedKg, accruedReceiptPayableInr, status: nextStatus },
  })

  return { totalReceivedKg, totalUsableReceivedKg, accruedReceiptPayableInr, orderedKg, status: nextStatus }
}
