import { describe, it, expect } from 'vitest'
import { rankParentSheetMatches, type RankableOption } from './smart-match-ranking'

function opt(over: Partial<RankableOption>): RankableOption {
  return {
    materialId: over.materialId ?? Math.random().toString(36).slice(2),
    materialCode: 'C', status: 'Ready', yieldPct: 90, wastePct: 5,
    balanceReusable: false, balanceArea: 0, balanceSize: null,
    freeSheets: 1000, isLeftover: false, fitScore: 50, ...over,
  }
}

describe('rankParentSheetMatches', () => {
  it('ranks a fulfillable option above a higher-yield shortage option', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'hi', yieldPct: 98, status: 'Shortage' }),
      opt({ materialId: 'ok', yieldPct: 90, status: 'Ready' }),
    ])
    expect(ranked[0].materialId).toBe('ok')
    expect(ranked[0].matchRank).toBe(1)
  })

  it('among fulfillable, higher yield wins', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'a', yieldPct: 90, status: 'Ready' }),
      opt({ materialId: 'b', yieldPct: 95, status: 'Ready' }),
    ])
    expect(ranked[0].materialId).toBe('b')
  })

  it('equal yield → lower waste (reusable balance) wins', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'sliver', yieldPct: 90, wastePct: 8, balanceReusable: false }),
      opt({ materialId: 'reuse', yieldPct: 90, wastePct: 2, balanceReusable: true, balanceArea: 400 }),
    ])
    expect(ranked[0].materialId).toBe('reuse')
  })

  it('equal yield+waste → more free stock wins', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'low', yieldPct: 90, wastePct: 5, freeSheets: 500 }),
      opt({ materialId: 'high', yieldPct: 90, wastePct: 5, freeSheets: 9000 }),
    ])
    expect(ranked[0].materialId).toBe('high')
  })

  it('emits a 0-100 score and an in-stock reason', () => {
    const ranked = rankParentSheetMatches([opt({ status: 'Ready', yieldPct: 97, balanceReusable: true, balanceSize: '11 x 25' })])
    expect(ranked[0].matchScore).toBeGreaterThanOrEqual(0)
    expect(ranked[0].matchScore).toBeLessThanOrEqual(100)
    expect(ranked[0].recommendationReason).toMatch(/In stock/)
    expect(ranked[0].recommendationReason).toMatch(/97/)
  })

  it('a Ready option beats a Partial one with higher yield (fulfillable gate)', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'partial', status: 'Partial', yieldPct: 99 }),
      opt({ materialId: 'ready', status: 'Ready', yieldPct: 70 }),
    ])
    expect(ranked[0].materialId).toBe('ready')
  })

  it('all else equal, existing balance/leftover stock is preferred', () => {
    const ranked = rankParentSheetMatches([
      opt({ materialId: 'fresh', isLeftover: false }),
      opt({ materialId: 'leftover', isLeftover: true }),
    ])
    expect(ranked[0].materialId).toBe('leftover')
  })

  it('reasons reflect Partial and Shortage statuses', () => {
    expect(rankParentSheetMatches([opt({ status: 'Partial' })])[0].recommendationReason).toMatch(/Partial — raise PR/)
    expect(rankParentSheetMatches([opt({ status: 'Shortage' })])[0].recommendationReason).toMatch(/Out of stock/)
  })
})
