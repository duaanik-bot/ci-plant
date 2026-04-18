/** Total landed cost (TLC) per kg: basic mill rate + allocated logistics per kg. */

export type LandedCostInputs = {
  basicRatePerKg: number
  totalWeightKg: number
  freightTotalInr: number
  unloadingChargesInr: number
  insuranceMiscInr: number
}

export function computeLandedRatePerKg(input: LandedCostInputs): number {
  const basic = input.basicRatePerKg
  const w = input.totalWeightKg
  if (!Number.isFinite(basic) || basic < 0) return 0
  if (!Number.isFinite(w) || w <= 0) return Math.round(basic * 10000) / 10000
  const f = Number.isFinite(input.freightTotalInr) ? input.freightTotalInr : 0
  const u = Number.isFinite(input.unloadingChargesInr) ? input.unloadingChargesInr : 0
  const i = Number.isFinite(input.insuranceMiscInr) ? input.insuranceMiscInr : 0
  const perKg = (f + u + i) / w
  return Math.round((basic + perKg) * 10000) / 10000
}

/** Share of basic rate represented by freight-only per kg (for grid hint). */
export function freightPctOfBasicRate(
  basicRatePerKg: number,
  totalWeightKg: number,
  freightTotalInr: number,
): number | null {
  if (!Number.isFinite(basicRatePerKg) || basicRatePerKg <= 0) return null
  if (!Number.isFinite(totalWeightKg) || totalWeightKg <= 0) return null
  const f = Number.isFinite(freightTotalInr) ? freightTotalInr : 0
  if (f <= 0) return 0
  const freightPerKg = f / totalWeightKg
  return Math.round((freightPerKg / basicRatePerKg) * 1000) / 10
}

/** True if total logistics uplift vs basic exceeds threshold (default 10%). */
export function isHighLogisticsCostVsBasic(
  basicRatePerKg: number,
  landedRatePerKg: number,
  thresholdPct = 10,
): boolean {
  if (!Number.isFinite(basicRatePerKg) || basicRatePerKg <= 0) return false
  if (!Number.isFinite(landedRatePerKg)) return false
  const upliftPct = ((landedRatePerKg - basicRatePerKg) / basicRatePerKg) * 100
  return upliftPct > thresholdPct
}
