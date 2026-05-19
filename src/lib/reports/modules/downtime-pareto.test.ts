import { describe, it, expect } from 'vitest'
import { computeDowntimePareto, type DtInput } from './downtime-pareto'

const input: DtInput[] = [
  { reason: 'makeready', minutes: 120 },
  { reason: 'makeready', minutes: 60 },
  { reason: 'breakdown', minutes: 90 },
  { reason: 'no_material', minutes: 30 },
]

describe('computeDowntimePareto', () => {
  const r = computeDowntimePareto(input)
  it('aggregates by reason sorted desc with cumulative %', () => {
    expect(r.rows[0]).toMatchObject({ reason: 'makeready', minutes: 180, occurrences: 2 })
    const last = r.rows[r.rows.length - 1]
    expect(Number(last.cumulativePct)).toBeCloseTo(100, 1)
  })
  it('summary shows total downtime and top reason', () => {
    expect(r.summary.find((s) => s.label === 'Total Downtime (min)')!.value).toBe('300')
    expect(r.summary.find((s) => s.label === 'Top Reason')!.value).toContain('makeready')
  })
  it('chart is pareto', () => {
    expect(r.chart!.kind).toBe('pareto')
  })
})
