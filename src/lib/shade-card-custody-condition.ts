/** Physical condition for shade-card custody handshake (issue / receive). */
export const SHADE_CARD_PHYSICAL_CONDITION = ['mint', 'used', 'minor_damage'] as const
export type ShadeCardPhysicalCondition = (typeof SHADE_CARD_PHYSICAL_CONDITION)[number]

const RANK: Record<ShadeCardPhysicalCondition, number> = {
  mint: 0,
  used: 1,
  minor_damage: 2,
}

export function shadeCardPhysicalConditionRank(c: ShadeCardPhysicalCondition): number {
  return RANK[c]
}

/** If end rank is lower than initial, physical state degraded vs checkout baseline → damage report. */
export function shadeCardConditionIndicatesDamage(
  initial: ShadeCardPhysicalCondition | null | undefined,
  end: ShadeCardPhysicalCondition,
): boolean {
  if (!initial) return false
  return shadeCardPhysicalConditionRank(end) < shadeCardPhysicalConditionRank(initial)
}

/** Map UI condition to legacy inventory condition on the shade row. */
export function shadeCardPhysicalToLegacyCondition(
  c: ShadeCardPhysicalCondition,
): 'Good' | 'Damaged' | 'Needs Repair' {
  if (c === 'minor_damage') return 'Needs Repair'
  return 'Good'
}

export function shadeCardPhysicalLabel(c: ShadeCardPhysicalCondition): string {
  if (c === 'mint') return 'Mint'
  if (c === 'used') return 'Used'
  return 'Minor damage'
}
