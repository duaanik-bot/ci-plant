import { describe, it, expect } from 'vitest'
import { fmtInr, fmtPct, fmtNum, fmtDate, fmtCell } from './format'

describe('reports/format', () => {
  it('formats INR as whole rupees with thousands separators', () => {
    expect(fmtInr(1234567.89)).toBe('₹12,34,568')
    expect(fmtInr(-500)).toBe('-₹500')
    expect(fmtInr(0)).toBe('₹0')
  })
  it('formats percent to 2 dp with sign', () => {
    expect(fmtPct(96.4567)).toBe('96.46%')
    expect(fmtPct(0)).toBe('0.00%')
  })
  it('formats numbers with thousands grouping', () => {
    expect(fmtNum(1234567)).toBe('12,34,567')
  })
  it('formats dates as dd-MMM-yy', () => {
    expect(fmtDate(new Date('2026-05-18T00:00:00Z'))).toBe('18-May-26')
    expect(fmtDate(null)).toBe('—')
  })
  it('fmtCell dispatches by column type', () => {
    expect(fmtCell(1000, 'inr')).toBe('₹1,000')
    expect(fmtCell(50, 'pct')).toBe('50.00%')
    expect(fmtCell('CI-01', 'text')).toBe('CI-01')
    expect(fmtCell(null, 'num')).toBe('—')
  })
})
