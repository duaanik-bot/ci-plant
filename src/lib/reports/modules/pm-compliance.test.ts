import { describe, it, expect } from 'vitest'
import { computePmCompliance, type PmInput } from './pm-compliance'

const input: PmInput[] = [
  { machine: 'CI-01', scheduled: 4, completed: 4, overdue: 0 },
  { machine: 'CI-02', scheduled: 4, completed: 2, overdue: 1 },
]

describe('computePmCompliance', () => {
  const r = computePmCompliance(input)
  it('computes compliance % per machine', () => {
    expect(r.rows.find((x) => x.machine === 'CI-01')!.compliancePct).toBe(100)
    expect(r.rows.find((x) => x.machine === 'CI-02')!.compliancePct).toBe(50)
  })
  it('plant compliance and overdue count in summary', () => {
    expect(r.summary.find((s) => s.label === 'Plant PM Compliance %')!.value).toBe('75.00%')
    expect(r.summary.find((s) => s.label === 'Plant PM Compliance %')!.tone).toBe('bad')
    expect(r.summary.find((s) => s.label === 'Overdue PMs')!.value).toBe('1')
  })
})
