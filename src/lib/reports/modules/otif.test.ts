import { describe, it, expect } from 'vitest'
import { computeOtif, type OtifInput } from './otif'

const input: OtifInput[] = [
  { po: 'PO1', customer: 'Acme', carton: 'C1', poQty: 1000, dispatchedQty: 1000,
    allowedQty: 1020, dueDate: '2026-05-10', dispatchedAt: '2026-05-09' },
  { po: 'PO2', customer: 'Acme', carton: 'C2', poQty: 1000, dispatchedQty: 900,
    allowedQty: 1020, dueDate: '2026-05-10', dispatchedAt: '2026-05-12' },
]

describe('computeOtif', () => {
  const r = computeOtif(input)
  it('flags per-line onTime/inFull/OTIF', () => {
    const a = r.rows.find((x) => x.po === 'PO1')!
    expect(a.onTime).toBe('Yes'); expect(a.inFull).toBe('Yes'); expect(a.otif).toBe('Yes')
    const b = r.rows.find((x) => x.po === 'PO2')!
    expect(b.onTime).toBe('No'); expect(b.inFull).toBe('No'); expect(b.otif).toBe('No')
  })
  it('computes OTIF% and counts', () => {
    expect(r.summary.find((s) => s.label === 'OTIF %')!.value).toBe('50.00%')
    expect(r.summary.find((s) => s.label === 'Late')!.value).toBe('1')
    expect(r.summary.find((s) => s.label === 'Short')!.value).toBe('1')
  })
})
