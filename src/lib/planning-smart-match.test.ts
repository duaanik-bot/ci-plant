import { describe, expect, it } from 'vitest'
import {
  type SmartMatchInput,
  rankBoardMatches,
  scoreBoardMatch,
} from '@/lib/planning-smart-match'

function opt(over: Partial<SmartMatchInput> & { materialId: string }): SmartMatchInput {
  return {
    materialCode: over.materialId,
    boardType: 'FBB',
    gsm: 300,
    size: '720x1020',
    freeSheets: 5000,
    requiredParentSheets: 1000,
    shortageParentSheets: 0,
    wastagePct: 10,
    yieldPct: 85,
    cutsPerSheet: 2,
    matchType: 'Cut Fit',
    status: 'Ready',
    gsmDelta: 0,
    tags: [],
    boardMatchMode: 'exact',
    ...over,
  }
}

describe('scoreBoardMatch', () => {
  it('scores a high-yield, low-waste, exact-GSM, in-stock option near the top', () => {
    expect(scoreBoardMatch(opt({ materialId: 'a', yieldPct: 95, wastagePct: 5 }))).toBeGreaterThan(85)
  })
  it('penalises high waste and GSM distance', () => {
    const good = scoreBoardMatch(opt({ materialId: 'a', wastagePct: 5, gsmDelta: 0 }))
    const bad = scoreBoardMatch(opt({ materialId: 'b', wastagePct: 60, gsmDelta: 15 }))
    expect(bad).toBeLessThan(good)
  })
  it('penalises a shortage (low availability)', () => {
    const stocked = scoreBoardMatch(opt({ materialId: 'a', freeSheets: 5000 }))
    const short = scoreBoardMatch(opt({ materialId: 'b', freeSheets: 0 }))
    expect(short).toBeLessThan(stocked)
  })
})

describe('rankBoardMatches', () => {
  it('returns nothing for an empty pool', () => {
    expect(rankBoardMatches([])).toEqual([])
  })

  it('assigns distinct buckets, each material once, ranked 1..n', () => {
    const ranked = rankBoardMatches([
      opt({ materialId: 'best', yieldPct: 95, wastagePct: 8, gsmDelta: 0, freeSheets: 3000 }),
      opt({ materialId: 'lowwaste', yieldPct: 80, wastagePct: 2, gsmDelta: 5, freeSheets: 2000 }),
      opt({ materialId: 'closegsm', yieldPct: 70, wastagePct: 20, gsmDelta: 1, freeSheets: 1500 }),
      opt({ materialId: 'mostavail', yieldPct: 65, wastagePct: 25, gsmDelta: 10, freeSheets: 9000 }),
    ])
    const ids = ranked.map((r) => r.materialId)
    expect(new Set(ids).size).toBe(ids.length) // no material repeats
    expect(ranked.map((r) => r.rank)).toEqual(ranked.map((_, i) => i + 1))
    expect(ranked[0].bucket).toBe('best')
    const buckets = ranked.map((r) => r.bucket)
    expect(buckets).toContain('lowest_waste')
    expect(buckets).toContain('closest_gsm')
  })

  it('routes a shortage option to manual_review', () => {
    const ranked = rankBoardMatches([
      opt({ materialId: 'ready', status: 'Ready' }),
      opt({ materialId: 'short', status: 'Shortage', shortageParentSheets: 400, freeSheets: 0 }),
    ])
    const manual = ranked.find((r) => r.bucket === 'manual_review')
    expect(manual?.materialId).toBe('short')
    expect(manual?.reason).toMatch(/shortfall/i)
    expect(manual?.tags).toContain('Shortage')
  })

  it('skips closest_gsm when no option carries a GSM delta', () => {
    const ranked = rankBoardMatches([
      opt({ materialId: 'a', gsmDelta: null }),
      opt({ materialId: 'b', gsmDelta: null }),
    ])
    expect(ranked.some((r) => r.bucket === 'closest_gsm')).toBe(false)
  })

  it('tags the highest-yield option Best Yield and exact matches Exact Match', () => {
    const ranked = rankBoardMatches([
      opt({ materialId: 'hi', yieldPct: 96, matchType: 'Direct Size' }),
      opt({ materialId: 'lo', yieldPct: 60 }),
    ])
    const hi = ranked.find((r) => r.materialId === 'hi')!
    expect(hi.tags).toContain('Best Yield')
    expect(hi.tags).toContain('Exact Match')
    expect(hi.matchScore).toBeGreaterThan(0)
  })
})
