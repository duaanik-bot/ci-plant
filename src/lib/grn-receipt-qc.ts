import type { VendorMaterialReceipt } from '@prisma/client'

/** Numeric snapshot for payable math (DB row or in-flight PATCH). */
export type GrnReceiptPayableInput = {
  receivedQty: unknown
  qcStatus: string | null
  qtyAcceptedStandard?: unknown
  qtyAcceptedPenalty?: unknown
  qtyRejected?: unknown
  qcActualGsm?: unknown
  qcPenaltyRecommendedInr?: unknown
  qcPerformedAt?: unknown
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

const LEGACY_COMPLETE = new Set(['PASSED', 'FAILED', 'PASSED_WITH_PENALTY'])

/** Receipt has finished QC (legacy status or new split + timestamp). */
export function isGrnQcComplete(r: Pick<
  VendorMaterialReceipt,
  'qcPerformedAt' | 'qcStatus' | 'qtyAcceptedStandard' | 'qtyAcceptedPenalty' | 'qtyRejected'
>): boolean {
  if (r.qtyAcceptedStandard != null && r.qtyAcceptedPenalty != null && r.qtyRejected != null) {
    return r.qcPerformedAt != null
  }
  return r.qcStatus != null && LEGACY_COMPLETE.has(r.qcStatus)
}

export function isGrnQcPending(r: Pick<
  VendorMaterialReceipt,
  'qcPerformedAt' | 'qcStatus' | 'qtyAcceptedStandard'
>): boolean {
  return !isGrnQcComplete(r as Parameters<typeof isGrnQcComplete>[0])
}

/** Kg that count toward usable stock (standard + penalty tranches). */
export function receiptUsableKg(r: Pick<
  VendorMaterialReceipt,
  | 'receivedQty'
  | 'qcStatus'
  | 'qtyAcceptedStandard'
  | 'qtyAcceptedPenalty'
  | 'qtyRejected'
>): number {
  if (r.qtyAcceptedStandard != null && r.qtyAcceptedPenalty != null) {
    return round6(Number(r.qtyAcceptedStandard) + Number(r.qtyAcceptedPenalty))
  }
  if (r.qcStatus === 'PASSED' || r.qcStatus === 'PASSED_WITH_PENALTY') {
    return round6(Number(r.receivedQty))
  }
  return 0
}

/**
 * Accrued payable for this receipt (₹): (Standard × Rate) + (Penalty × Adjusted_Rate).
 * Adjusted_Rate = Rate × (Actual_GSM / Ordered_GSM) when GSM shortfall on penalty tranche.
 */
export function receiptAccruedPayableInr(
  r: GrnReceiptPayableInput,
  invoiceRatePerKg: number,
  orderedGsm: number | null,
  opts?: { assumeNewSplit?: boolean },
): number {
  const splitNumsReady =
    opts?.assumeNewSplit &&
    r.qtyAcceptedStandard != null &&
    r.qtyAcceptedPenalty != null &&
    r.qtyRejected != null
  if (!splitNumsReady && !isGrnQcComplete(r as Parameters<typeof isGrnQcComplete>[0])) return 0
  const rate = invoiceRatePerKg
  if (!Number.isFinite(rate) || rate <= 0) return 0

  if (r.qtyAcceptedStandard != null && r.qtyAcceptedPenalty != null) {
    const qs = Number(r.qtyAcceptedStandard)
    const qp = Number(r.qtyAcceptedPenalty)
    const act = r.qcActualGsm != null ? Number(r.qcActualGsm) : null
    let penaltyRate = rate
    if (
      qp > 0 &&
      orderedGsm != null &&
      orderedGsm > 0 &&
      act != null &&
      Number.isFinite(act) &&
      act > 0 &&
      act < orderedGsm
    ) {
      penaltyRate = rate * (act / orderedGsm)
    }
    return round2(qs * rate + qp * penaltyRate)
  }

  if (r.qcStatus === 'PASSED') {
    return round2(Number(r.receivedQty) * rate)
  }
  if (r.qcStatus === 'PASSED_WITH_PENALTY') {
    const gross = Number(r.receivedQty) * rate
    const debit = r.qcPenaltyRecommendedInr != null ? Number(r.qcPenaltyRecommendedInr) : 0
    return round2(Math.max(0, gross - debit))
  }
  return 0
}

export function validateQtySplitSum(
  receivedQty: number,
  standard: number,
  penalty: number,
  rejected: number,
  eps = 1e-4,
): { ok: boolean; sum: number } {
  const sum = standard + penalty + rejected
  return { ok: Math.abs(sum - receivedQty) <= eps, sum }
}

export function receiptHasPenaltyTranche(r: Pick<VendorMaterialReceipt, 'qtyAcceptedPenalty' | 'qcStatus'>): boolean {
  const qp = r.qtyAcceptedPenalty != null ? Number(r.qtyAcceptedPenalty) : 0
  return qp > 0 || r.qcStatus === 'PASSED_WITH_PENALTY'
}
