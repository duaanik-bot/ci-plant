/** Strike budget defaults by block material (override per block via maxImpressions). */
export function defaultMaxStrikesForMaterial(blockMaterial: string): number {
  const m = blockMaterial.trim().toLowerCase()
  if (m === 'magnesium') return 200_000
  if (m === 'brass') return 500_000
  if (m === 'copper') return 400_000
  return 200_000
}

export function effectiveStrikeLimit(params: { maxImpressions: number; blockMaterial: string }): number {
  if (params.maxImpressions > 0) return params.maxImpressions
  return defaultMaxStrikesForMaterial(params.blockMaterial)
}

export function strikeCountExceedsLimit(params: {
  impressionCount: number
  maxImpressions: number
  blockMaterial: string
}): boolean {
  const limit = effectiveStrikeLimit({
    maxImpressions: params.maxImpressions,
    blockMaterial: params.blockMaterial,
  })
  return params.impressionCount > limit
}
