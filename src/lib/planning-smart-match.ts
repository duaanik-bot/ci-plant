/**
 * Planning Engine — Smart Match ranking.
 *
 * Takes the board options the readiness API already computes and turns them
 * into a small ranked set of recommendations, each in a labelled bucket with a
 * 0–100 match score and a human reason. Pure + deterministic so it can be unit
 * tested and run client-side (no API change).
 */

export type SmartMatchBucket =
  | 'best'
  | 'lowest_waste'
  | 'closest_gsm'
  | 'most_available'
  | 'manual_review'

export const BUCKET_LABEL: Record<SmartMatchBucket, string> = {
  best: 'Best Match',
  lowest_waste: 'Lowest Wastage',
  closest_gsm: 'Closest GSM',
  most_available: 'Most Available',
  manual_review: 'Manual Review',
}

/** Structural subset of a board option the ranker needs. */
export type SmartMatchInput = {
  materialId: string
  materialCode?: string | null
  boardType?: string | null
  gsm?: number | null
  size?: string | null
  freeSheets: number
  requiredParentSheets: number
  shortageParentSheets: number
  wastagePct: number
  yieldPct: number
  cutsPerSheet: number
  matchType?: string | null
  status: 'Ready' | 'Partial' | 'Shortage'
  gsmDelta?: number | null
  tags?: string[]
  /** Optional flags the API attaches; used to detect fallback/manual matches. */
  boardMatchMode?: 'exact' | 'cross_field' | 'fallback' | null
}

export type RankedBoardMatch = SmartMatchInput & {
  rank: number
  bucket: SmartMatchBucket
  bucketLabel: string
  matchScore: number
  reason: string
  tags: string[]
}

const WEIGHTS = { yield: 0.35, waste: 0.25, gsm: 0.2, avail: 0.2 } as const

function clamp(n: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

/** Per-option 0–100 match score from yield, wastage, GSM proximity, availability. */
export function scoreBoardMatch(opt: SmartMatchInput): number {
  const yieldScore = clamp(opt.yieldPct)
  const wasteScore = clamp(100 - opt.wastagePct)
  const gsmScore = opt.gsmDelta == null ? 70 : clamp(100 - Math.abs(opt.gsmDelta) * 5)
  const required = Math.max(1, opt.requiredParentSheets)
  const availScore = clamp((Math.max(0, opt.freeSheets) / required) * 100)
  const composite =
    yieldScore * WEIGHTS.yield +
    wasteScore * WEIGHTS.waste +
    gsmScore * WEIGHTS.gsm +
    availScore * WEIGHTS.avail
  return Math.round(clamp(composite) * 10) / 10
}

function isManual(opt: SmartMatchInput): boolean {
  return opt.status === 'Shortage' || opt.boardMatchMode === 'fallback'
}

function fmtSheets(n: number): string {
  return new Intl.NumberFormat('en-IN').format(Math.round(n))
}

function gsmText(delta: number | null | undefined): string | null {
  if (delta == null || delta === 0) return 'exact GSM'
  return `${delta > 0 ? '+' : ''}${delta}g GSM`
}

function buildReason(opt: SmartMatchInput, bucket: SmartMatchBucket): string {
  const cover =
    opt.shortageParentSheets > 0
      ? `${fmtSheets(opt.shortageParentSheets)} sh short`
      : `${fmtSheets(opt.freeSheets)} sh free`
  switch (bucket) {
    case 'best':
      return [
        `${Math.round(opt.yieldPct)}% yield`,
        `${Math.round(opt.wastagePct)}% waste`,
        gsmText(opt.gsmDelta),
        cover,
      ]
        .filter(Boolean)
        .join(' · ')
    case 'lowest_waste':
      return `Lowest wastage at ${Math.round(opt.wastagePct)}% · ${cover}`
    case 'closest_gsm':
      return `${gsmText(opt.gsmDelta) ?? 'exact GSM'} · ${Math.round(opt.yieldPct)}% yield`
    case 'most_available':
      return `Most stock — ${fmtSheets(opt.freeSheets)} sh free · ${Math.round(opt.yieldPct)}% yield`
    case 'manual_review':
      return opt.shortageParentSheets > 0
        ? `Needs review — ${fmtSheets(opt.shortageParentSheets)} sh shortfall`
        : `Needs review — compatible board, verify before reserving`
  }
}

function augmentTags(opt: SmartMatchInput, bucket: SmartMatchBucket, isBestYield: boolean): string[] {
  const tags = new Set(opt.tags ?? [])
  if (bucket === 'lowest_waste') tags.add('Lowest Wastage')
  if (bucket === 'closest_gsm') tags.add('Closest GSM')
  if (isBestYield) tags.add('Best Yield')
  if (opt.gsmDelta === 0) tags.add('Exact GSM')
  if ((opt.matchType ?? '').toLowerCase().includes('direct')) tags.add('Exact Match')
  if (opt.status === 'Shortage') tags.add('Shortage')
  return Array.from(tags)
}

/**
 * Rank board options into up to 5 labelled buckets. Each material appears once,
 * assigned to the highest-priority bucket it best fits. Order:
 *   Best Match → Lowest Wastage → Closest GSM → Most Available → Manual Review.
 */
export function rankBoardMatches(options: SmartMatchInput[]): RankedBoardMatch[] {
  if (options.length === 0) return []

  const scored = options.map((opt) => ({ opt, score: scoreBoardMatch(opt) }))
  const cleanFirst = (a: (typeof scored)[number], b: (typeof scored)[number]) => b.score - a.score
  const bestYieldId = [...options].sort((a, b) => b.yieldPct - a.yieldPct)[0]?.materialId

  const used = new Set<string>()
  const take = (
    bucket: SmartMatchBucket,
    pick: (pool: (typeof scored)[number][]) => (typeof scored)[number] | undefined,
  ): RankedBoardMatch | null => {
    const pool = scored.filter((s) => !used.has(s.opt.materialId))
    if (pool.length === 0) return null
    const chosen = pick(pool)
    if (!chosen) return null
    used.add(chosen.opt.materialId)
    return {
      ...chosen.opt,
      rank: 0,
      bucket,
      bucketLabel: BUCKET_LABEL[bucket],
      matchScore: chosen.score,
      reason: buildReason(chosen.opt, bucket),
      tags: augmentTags(chosen.opt, bucket, chosen.opt.materialId === bestYieldId),
    }
  }

  const out: RankedBoardMatch[] = []

  // Clean buckets (#1–#4) draw only from non-shortage / non-fallback options.
  // Shortage / fallback options are reserved for #5 Manual Review.
  const clean = (pool: (typeof scored)[number][]) => pool.filter((s) => !isManual(s.opt))

  // #1 Best Match — highest composite score.
  const best = take('best', (pool) => [...clean(pool)].sort(cleanFirst)[0])
  if (best) out.push(best)

  // #2 Lowest Wastage
  const lw = take('lowest_waste', (pool) =>
    [...clean(pool)].sort((a, b) => a.opt.wastagePct - b.opt.wastagePct)[0],
  )
  if (lw) out.push(lw)

  // #3 Closest GSM (only when a GSM delta is known)
  const cg = take('closest_gsm', (pool) => {
    const withGsm = clean(pool).filter((s) => s.opt.gsmDelta != null)
    if (withGsm.length === 0) return undefined
    return [...withGsm].sort((a, b) => Math.abs(a.opt.gsmDelta!) - Math.abs(b.opt.gsmDelta!))[0]
  })
  if (cg) out.push(cg)

  // #4 Most Available
  const ma = take('most_available', (pool) =>
    [...clean(pool)].sort((a, b) => b.opt.freeSheets - a.opt.freeSheets)[0],
  )
  if (ma) out.push(ma)

  // #5 Manual Review — surface a shortage/fallback option that still needs a human.
  const mr = take('manual_review', (pool) => {
    const manual = pool.filter((s) => isManual(s.opt))
    return [...manual].sort(cleanFirst)[0]
  })
  if (mr) out.push(mr)

  return out.map((m, i) => ({ ...m, rank: i + 1 }))
}
