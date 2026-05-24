import { describe, it, expect } from 'vitest'
import { computeYield, type YieldInput } from './yield'

const input: YieldInput[] = [
  { date: '2026-05-01', jobCard: 'JC1', machine: 'PRN-01', operator: 'A',
    totalPieces: 10000, goodPieces: 9800, yield: 98, incentiveEligible: true },
  { date: '2026-05-02', jobCard: 'JC2', machine: 'PRN-02', operator: 'B',
    totalPieces: 8000, goodPieces: 7200, yield: 90, incentiveEligible: false },
]

describe('computeYield', () => {
  const r = computeYield(input)
  it('computes avg yield and incentive count', () => {
    expect(r.summary.find((s) => s.label === 'Avg Yield %')!.value).toBe('94.00%')
    expect(r.summary.find((s) => s.label === 'Incentive-Eligible Jobs')!.value).toBe('1')
  })
  it('avg yield tone bad below 96 target', () => {
    expect(r.summary.find((s) => s.label === 'Avg Yield %')!.tone).toBe('bad')
  })
  it('identifies worst-yield job', () => {
    expect(r.summary.find((s) => s.label === 'Worst Job')!.value).toContain('JC2')
  })
})
