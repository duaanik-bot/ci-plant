/** GSM from the heaviest vendor PO line (spec anchor for receipt QC). */
export function orderedGsmFromVendorLines(
  lines: { gsm: number; totalWeightKg: unknown }[],
): number | null {
  if (lines.length === 0) return null
  let bestGsm = lines[0]!.gsm
  let bestKg = Number(lines[0]!.totalWeightKg)
  for (let i = 1; i < lines.length; i++) {
    const li = lines[i]!
    const kg = Number(li.totalWeightKg)
    if (kg > bestKg) {
      bestKg = kg
      bestGsm = li.gsm
    }
  }
  return Number.isFinite(bestGsm) ? bestGsm : null
}

/** Relative deviation; e.g. 0.06 means 6% (triggers critical when > 0.05). */
export function gsmDeviationRatio(actualGsm: number, orderedGsm: number): number | null {
  if (!Number.isFinite(actualGsm) || !Number.isFinite(orderedGsm) || orderedGsm <= 0) return null
  return Math.abs(actualGsm - orderedGsm) / orderedGsm
}

/** ₹/kg from the heaviest vendor PO line (same anchor as ordered GSM). */
export function invoiceRateFromVendorLines(
  lines: { totalWeightKg: unknown; ratePerKg: unknown }[],
): number | null {
  if (lines.length === 0) return null
  let bestRate: number | null = null
  let bestKg = -1
  for (const li of lines) {
    const kg = Number(li.totalWeightKg)
    if (!Number.isFinite(kg)) continue
    const r = li.ratePerKg != null ? Number(li.ratePerKg) : NaN
    if (kg > bestKg) {
      bestKg = kg
      bestRate = Number.isFinite(r) && r > 0 ? r : null
    }
  }
  return bestRate
}
