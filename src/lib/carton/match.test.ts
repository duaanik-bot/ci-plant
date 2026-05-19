import { describe, it, expect } from 'vitest'
import { levenshtein, nameSimilarity, dimensionMatch, scoreSuggestion } from './match'

describe('levenshtein', () => {
  it('identical → 0', () => expect(levenshtein('antox', 'antox')).toBe(0))
  it('one edit', () => expect(levenshtein('antox', 'antux')).toBe(1))
})

describe('nameSimilarity', () => {
  it('identical → 1', () => expect(nameSimilarity('ANTOX', 'antox')).toBe(1))
  it('disjoint → low', () => expect(nameSimilarity('abc', 'xyz')).toBeLessThan(0.4))
})

describe('dimensionMatch', () => {
  const target = { l: 138, w: 50, h: 108 }
  it('within tolerance on all axes', () => {
    expect(dimensionMatch(target, { l: 139, w: 51, h: 107 }, 3)).toBe('exact')
  })
  it('rotated orientation', () => {
    expect(dimensionMatch(target, { l: 50, w: 138, h: 108 }, 3)).toBe('rotated')
  })
  it('far off → none', () => {
    expect(dimensionMatch(target, { l: 200, w: 90, h: 5 }, 3)).toBe('none')
  })
})

describe('scoreSuggestion', () => {
  it('full client+name+dim+spec match scores near 100', () => {
    const s = scoreSuggestion({
      clientMatch: true,
      nameSim: 1,
      dimWithinTol: true,
      specMatch: 1,
    })
    expect(s).toBeGreaterThanOrEqual(95)
  })
  it('no signals → 0', () => {
    expect(
      scoreSuggestion({ clientMatch: false, nameSim: 0, dimWithinTol: false, specMatch: 0 }),
    ).toBe(0)
  })
})
