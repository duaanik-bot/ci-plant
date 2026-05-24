import { describe, it, expect } from 'vitest'
import { scoreGangSuggestions } from './planning-smart-match'

// Anchor line
const anchor = {
  id: 'A',
  quantity: 10000,
  ups: 4,
  sheetSize: '760x1020',
  gsm: 300,
  boardType: 'FBB',
  coating: 'gloss',
  printSide: 'single',
  deliveryDays: 5,
  yieldPct: 90,
}

// Compatible-and-good: same board/gsm/coating/side/size → survives tool filter, ranks high
const candB = {
  id: 'B',
  quantity: 8000,
  ups: 4,
  sheetSize: '760x1020',
  gsm: 300,
  boardType: 'FBB',
  coating: 'gloss',
  printSide: 'single',
  deliveryDays: 6,
  yieldPct: 88,
  poRef: 'PO-2',
}

// Compatible-but-worse: same board/gsm/coating/side (survives filter) but different size + far delivery → ranks last
const candC = {
  id: 'C',
  quantity: 5000,
  ups: 2,
  sheetSize: '500x700',
  gsm: 300,
  boardType: 'FBB',
  coating: 'gloss',
  printSide: 'single',
  deliveryDays: 60,
  yieldPct: 60,
  poRef: 'PO-3',
}

// Truly incompatible: different board/gsm/coating/side → tool === 0 → filtered out
const candIncompat = {
  id: 'Z',
  quantity: 3000,
  ups: 2,
  sheetSize: '500x700',
  gsm: 350,
  boardType: 'SBS',
  coating: 'matt',
  printSide: 'double',
  deliveryDays: 30,
  yieldPct: 70,
  poRef: 'PO-9',
}

describe('scoreGangSuggestions', () => {
  it('ranks the compatible sibling above the incompatible one', () => {
    const out = scoreGangSuggestions(anchor, [candB, candC], {})
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].label).toBe('#1')
    expect(out[0].poRefs).toContain('PO-2')
    expect(out[0].composite).toBeGreaterThan(out[out.length - 1].composite)
  })

  it('caps at five suggestions and labels them #1..#5', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...candB, id: `X${i}`, poRef: `PO-${i}` }))
    const out = scoreGangSuggestions(anchor, many, {})
    expect(out.length).toBeLessThanOrEqual(5)
    expect(out.map((s) => s.label)).toEqual(out.map((_, i) => `#${i + 1}`))
  })

  it('scores size match high when sheet sizes equal', () => {
    const out = scoreGangSuggestions(anchor, [candB], {})
    expect(out[0].sizeScore).toBeGreaterThanOrEqual(90)
  })

  it('drops fully-incompatible candidates (no shared board/gsm/coating/side)', () => {
    const out = scoreGangSuggestions(anchor, [candIncompat], {})
    expect(out.length).toBe(0)
  })
})
