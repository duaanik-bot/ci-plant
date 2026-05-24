import { describe, it, expect } from 'vitest'
import { computeOee, type OeeInput } from './oee'

const input: OeeInput[] = [
  { date: '2026-05-01', machine: 'PRN-01', operator: 'A', shiftMin: 480, runMin: 420,
    availability: 87.5, performance: 90, quality: 98, oee: 77.2, goodPieces: 9800, totalPieces: 10000, yield: 98 },
  { date: '2026-05-02', machine: 'PRN-02', operator: 'B', shiftMin: 480, runMin: 300,
    availability: 62, performance: 80, quality: 95, oee: 47.1, goodPieces: 4750, totalPieces: 5000, yield: 95 },
]

describe('computeOee', () => {
  const r = computeOee(input)
  it('averages OEE and counts jobs below 85 target', () => {
    expect(r.summary.find((s) => s.label === 'Avg OEE %')!.value).toBe('62.15%')
    expect(r.summary.find((s) => s.label === 'Jobs Below Target')!.value).toBe('2')
  })
  it('avg OEE tone is bad when below 85', () => {
    expect(r.summary.find((s) => s.label === 'Avg OEE %')!.tone).toBe('bad')
  })
  it('emits a bar chart of OEE by machine', () => {
    expect(r.chart!.kind).toBe('bar')
    expect(r.chart!.x).toBe('machine')
  })
})
