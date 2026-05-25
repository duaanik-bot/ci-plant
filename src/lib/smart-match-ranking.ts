export type RankableOption = {
  materialId: string
  materialCode: string
  status: 'Ready' | 'Partial' | 'Shortage'
  yieldPct: number
  wastePct: number
  balanceReusable: boolean
  balanceArea: number
  balanceSize: string | null
  freeSheets: number
  isLeftover: boolean
  fitScore: number
}

export type RankedMatch<T extends RankableOption = RankableOption> = T & {
  matchRank: number
  matchScore: number
  recommendationReason: string
}

// Tier-1 gate: only 'Ready' (fully reservable from free stock) counts as fulfillable.
// 'Partial' and 'Shortage' both still need a PR, so neither is fulfillable here — they
// are then ordered against each other by yield/waste/etc. (matchScore still distinguishes them).
function isFulfillable(o: RankableOption): boolean {
  return o.status === 'Ready'
}

function compare(a: RankableOption, b: RankableOption): number {
  // 1. fulfillable first (no procurement needed)
  const fa = isFulfillable(a) ? 1 : 0
  const fb = isFulfillable(b) ? 1 : 0
  if (fa !== fb) return fb - fa
  // 2. highest yield
  if (a.yieldPct !== b.yieldPct) return b.yieldPct - a.yieldPct
  // 3. lowest (unrecoverable) waste
  if (a.wastePct !== b.wastePct) return a.wastePct - b.wastePct
  // 4. reusable offcut, then larger reusable area
  const ra = a.balanceReusable ? 1 : 0
  const rb = b.balanceReusable ? 1 : 0
  if (ra !== rb) return rb - ra
  if (a.balanceArea !== b.balanceArea) return b.balanceArea - a.balanceArea
  // 5. most free stock
  if (a.freeSheets !== b.freeSheets) return b.freeSheets - a.freeSheets
  // 6. prefer existing balance/leftover stock
  const la = a.isLeftover ? 1 : 0
  const lb = b.isLeftover ? 1 : 0
  if (la !== lb) return lb - la
  // 7. final tiebreak: size/gsm fit, then code
  if (a.fitScore !== b.fitScore) return b.fitScore - a.fitScore
  return a.materialCode.localeCompare(b.materialCode)
}

function clamp(x: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, x))
}

function scoreOf(o: RankableOption): number {
  const inStock = o.status === 'Ready' ? 100 : o.status === 'Partial' ? 50 : 0
  const reuse = o.balanceReusable ? 100 : 0
  const raw = 0.35 * o.yieldPct + 0.25 * (100 - o.wastePct) + 0.25 * inStock + 0.15 * reuse
  return Math.round(clamp(raw))
}

function reasonOf(o: RankableOption): string {
  const parts: string[] = []
  if (o.status === 'Ready') parts.push('In stock')
  else if (o.status === 'Partial') parts.push('Partial — raise PR')
  else parts.push('Out of stock — raise PR')
  parts.push(`yield ${o.yieldPct}%`)
  if (o.balanceReusable && o.balanceSize) parts.push(`reusable ${o.balanceSize} balance`)
  if (o.isLeftover) parts.push('uses balance stock')
  return parts.join(' · ')
}

export function rankParentSheetMatches<T extends RankableOption>(options: T[]): RankedMatch<T>[] {
  return [...options]
    .sort(compare)
    .map((o, idx) => ({ ...o, matchRank: idx + 1, matchScore: scoreOf(o), recommendationReason: reasonOf(o) }))
}
