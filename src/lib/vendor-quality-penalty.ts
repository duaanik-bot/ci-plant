/**
 * Quality-based debit: technical shortfall when Actual GSM < Ordered GSM.
 * Value_Loss = (Invoice_Rate * Received_Qty) * (1 - (Actual_GSM / Ordered_GSM))
 */
export type QualityPenaltyResult = {
  eligible: boolean
  /** (1 - actual/ordered) * 100 */
  technicalShortfallPct: number
  valueLossInr: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function computeQualityPenaltyInr(params: {
  invoiceRatePerKg: number
  receivedQtyKg: number
  actualGsm: number
  orderedGsm: number
}): QualityPenaltyResult {
  const { invoiceRatePerKg, receivedQtyKg, actualGsm, orderedGsm } = params
  if (
    !Number.isFinite(invoiceRatePerKg) ||
    invoiceRatePerKg <= 0 ||
    !Number.isFinite(receivedQtyKg) ||
    receivedQtyKg <= 0 ||
    !Number.isFinite(actualGsm) ||
    !Number.isFinite(orderedGsm) ||
    orderedGsm <= 0
  ) {
    return { eligible: false, technicalShortfallPct: 0, valueLossInr: 0 }
  }
  if (actualGsm >= orderedGsm) {
    return { eligible: false, technicalShortfallPct: 0, valueLossInr: 0 }
  }
  const ratio = actualGsm / orderedGsm
  const technicalShortfallPct = round2((1 - ratio) * 100)
  const valueLossInr = round2(invoiceRatePerKg * receivedQtyKg * (1 - ratio))
  return {
    eligible: true,
    technicalShortfallPct,
    valueLossInr,
  }
}

export function formatQualityPenaltyProofLines(p: {
  orderedGsm: number
  actualGsm: number
  invoiceRatePerKg: number
  receivedQtyKg: number
  /** When set (>0), debit applies only to this penalty tranche (partial rejection QC). */
  penaltyQtyKg?: number
  shortfallPct: number
  valueLossInr: number
}): string[] {
  const { orderedGsm, actualGsm, invoiceRatePerKg, receivedQtyKg, shortfallPct, valueLossInr } = p
  const q =
    p.penaltyQtyKg != null && Number.isFinite(p.penaltyQtyKg) && p.penaltyQtyKg > 0
      ? p.penaltyQtyKg
      : receivedQtyKg
  return [
    'Value_Loss = (Invoice_Rate × Penalty_Qty_kg) × (1 − (Actual_GSM / Ordered_GSM))',
    `= (${invoiceRatePerKg} ₹/kg × ${q} kg) × (1 − (${actualGsm} / ${orderedGsm}))`,
    `Technical shortfall: ${shortfallPct.toFixed(2)}%`,
    `Recommended debit (technical variance): ₹${valueLossInr.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  ]
}
