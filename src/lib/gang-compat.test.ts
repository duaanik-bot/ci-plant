import { describe, it, expect } from 'vitest'
import { checkGangCompat, type GangCompatLine } from './gang-compat'

const base: GangCompatLine = {
  id: 'A',
  boardType: 'FBB',
  gsm: 300,
  coating: 'gloss',
  printSide: 'single',
  sheetSize: '760x1020',
  deliveryDays: 5,
  press: 'KBA',
}

const identical: GangCompatLine = {
  id: 'B',
  boardType: 'FBB',
  gsm: 300,
  coating: 'gloss',
  printSide: 'single',
  sheetSize: '760x1020',
  deliveryDays: 5,
  press: 'KBA',
}

describe('checkGangCompat', () => {
  it('single line → ok with no conflicts or warnings', () => {
    const result = checkGangCompat([base])
    expect(result.ok).toBe(true)
    expect(result.conflicts).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('identical lines → ok with no conflicts or warnings', () => {
    const result = checkGangCompat([base, identical])
    expect(result.ok).toBe(true)
    expect(result.conflicts).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('different boardType → hard conflict, ok=false', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', boardType: 'SBS' }
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(false)
    expect(result.conflicts.some((c) => c.field === 'boardType')).toBe(true)
    const conflict = result.conflicts.find((c) => c.field === 'boardType')!
    expect(conflict.values).toContain('fbb')
    expect(conflict.values).toContain('sbs')
  })

  it('different coating → hard conflict, ok=false', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', coating: 'matte' }
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(false)
    expect(result.conflicts.some((c) => c.field === 'coating')).toBe(true)
  })

  it('different printSide → hard conflict, ok=false', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', printSide: 'double' }
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(false)
    expect(result.conflicts.some((c) => c.field === 'printSide')).toBe(true)
  })

  it('gsm within tolerance (≤10) → ok, no gsm conflict', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', gsm: 308 } // diff = 8, within default 10
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(true)
    expect(result.conflicts.some((c) => c.field === 'gsm')).toBe(false)
  })

  it('gsm beyond tolerance (>10) → hard conflict', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', gsm: 350 } // diff = 50 > 10
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(false)
    expect(result.conflicts.some((c) => c.field === 'gsm')).toBe(true)
  })

  it('gsm exactly at tolerance boundary (=10) → ok (not beyond)', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', gsm: 310 } // diff = 10, not > 10
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(true)
    expect(result.conflicts.some((c) => c.field === 'gsm')).toBe(false)
  })

  it('custom gsmTolerance respected', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', gsm: 315 } // diff = 15
    const resultDefault = checkGangCompat([base, lineB]) // default tol=10 → conflict
    expect(resultDefault.ok).toBe(false)
    const resultLoose = checkGangCompat([base, lineB], { gsmTolerance: 20 }) // tol=20 → ok
    expect(resultLoose.ok).toBe(true)
  })

  it('different sheetSize → soft warning, ok still true', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', sheetSize: '720x1020' }
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.field === 'sheetSize')).toBe(true)
    expect(result.conflicts).toHaveLength(0)
  })

  it('different press → soft warning, ok still true', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', press: 'Heidelberg' }
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.field === 'press')).toBe(true)
    expect(result.conflicts).toHaveLength(0)
  })

  it('delivery beyond bucket (>7 days) → soft warning, ok still true', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', deliveryDays: 20 } // diff = 15 > 7
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.field === 'deliveryTimeline')).toBe(true)
    expect(result.conflicts).toHaveLength(0)
  })

  it('delivery within bucket (≤7 days) → no warning', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', deliveryDays: 10 } // diff = 5 ≤ 7
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.field === 'deliveryTimeline')).toBe(false)
  })

  it('custom deliveryBucketDays respected', () => {
    const lineB: GangCompatLine = { ...identical, id: 'B', deliveryDays: 10 } // diff = 5
    const resultTight = checkGangCompat([base, lineB], { deliveryBucketDays: 3 }) // 5 > 3 → warning
    expect(resultTight.warnings.some((w) => w.field === 'deliveryTimeline')).toBe(true)
    const resultLoose = checkGangCompat([base, lineB], { deliveryBucketDays: 10 }) // 5 ≤ 10 → ok
    expect(resultLoose.warnings.some((w) => w.field === 'deliveryTimeline')).toBe(false)
  })

  it('null/empty fields are treated as equal (no conflict)', () => {
    const lineA: GangCompatLine = { ...base, id: 'A', boardType: null, press: null }
    const lineB: GangCompatLine = { ...identical, id: 'B', boardType: null, press: null }
    const result = checkGangCompat([lineA, lineB])
    expect(result.ok).toBe(true)
    expect(result.conflicts).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('mixed hard conflict and soft warning returns ok=false', () => {
    const lineB: GangCompatLine = {
      ...identical,
      id: 'B',
      boardType: 'SBS',        // hard
      sheetSize: '720x1020',   // soft
    }
    const result = checkGangCompat([base, lineB])
    expect(result.ok).toBe(false)
    expect(result.conflicts.some((c) => c.field === 'boardType')).toBe(true)
    expect(result.warnings.some((w) => w.field === 'sheetSize')).toBe(true)
  })

  it('empty lines array → ok', () => {
    const result = checkGangCompat([])
    expect(result.ok).toBe(true)
    expect(result.conflicts).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })
})
