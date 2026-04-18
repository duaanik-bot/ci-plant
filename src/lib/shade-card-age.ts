/** Average days per month for lab / compliance age (CIE / shade policy). */
export const SHADE_CARD_DAYS_PER_MONTH = 30.44

/** Fractional age in months: (today − mfg) / 30.44 */
export function shadeCardAgeMonthsExact(mfgDate: Date | null | undefined): number | null {
  if (!mfgDate || Number.isNaN(mfgDate.getTime())) return null
  const start = Date.UTC(mfgDate.getFullYear(), mfgDate.getMonth(), mfgDate.getDate())
  const now = new Date()
  const end = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const days = (end - start) / 86_400_000
  if (days < 0) return 0
  return days / SHADE_CARD_DAYS_PER_MONTH
}

/** Integer months for coarse badges (floor of exact age). */
export function shadeCardAgeMonthsFloor(mfgDate: Date | null | undefined): number | null {
  const x = shadeCardAgeMonthsExact(mfgDate)
  if (x == null) return null
  return Math.floor(x)
}

export type ShadeCardAgeTier = 'fresh' | 'reverify' | 'expired'

export function shadeCardAgeTier(ageMonthsExact: number | null): ShadeCardAgeTier {
  if (ageMonthsExact == null) return 'fresh'
  if (ageMonthsExact > 12) return 'expired'
  if (ageMonthsExact >= 9) return 'reverify'
  return 'fresh'
}

/** Block issue to floor when card is strictly older than 12 months (30.44-day basis). */
export function shadeCardIsExpired(mfgDate: Date | null | undefined): boolean {
  const a = shadeCardAgeMonthsExact(mfgDate)
  return a != null && a > 12
}

/** KPI: cards past 9 months (re-verify + expired). */
export function shadeCardIsFadingStandard(ageMonthsExact: number | null): boolean {
  return ageMonthsExact != null && ageMonthsExact > 9
}

/** @deprecated Use shadeCardAgeMonthsExact — kept for older call sites expecting a number */
export function shadeCardAgeMonths(mfgDate: Date | null | undefined): number | null {
  return shadeCardAgeMonthsExact(mfgDate)
}
