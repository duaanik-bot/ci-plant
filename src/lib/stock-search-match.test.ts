import { describe, it, expect } from 'vitest'
import { stockRowMatchesTerm, type StockSearchRow } from './stock-search-match'

const row: StockSearchRow = {
  materialCode: 'C-2304-280', boardType: 'CYBER', gsm: 280,
  sheetLength: 23, sheetWidth: 36, storageLocation: 'Rack B-12',
  supplierName: 'Sappi', lot: 'L-4471',
}

describe('stockRowMatchesTerm', () => {
  it('matches on size string in either orientation', () => {
    expect(stockRowMatchesTerm(row, '23x36')).toBe(true)
    expect(stockRowMatchesTerm(row, '36 x 23')).toBe(true)
  })
  it('matches on lot, location, supplier, code, gsm (case-insensitive)', () => {
    expect(stockRowMatchesTerm(row, 'l-4471')).toBe(true)
    expect(stockRowMatchesTerm(row, 'rack b')).toBe(true)
    expect(stockRowMatchesTerm(row, 'sappi')).toBe(true)
    expect(stockRowMatchesTerm(row, 'c-2304')).toBe(true)
    expect(stockRowMatchesTerm(row, '280')).toBe(true)
  })
  it('empty term matches everything', () => {
    expect(stockRowMatchesTerm(row, '')).toBe(true)
  })
  it('non-match returns false', () => {
    expect(stockRowMatchesTerm(row, 'zzz')).toBe(false)
  })
  it('handles all-null optional fields without throwing', () => {
    const sparse: StockSearchRow = {
      materialCode: 'X-1', boardType: null, gsm: null,
      sheetLength: null, sheetWidth: null, storageLocation: null,
      supplierName: null, lot: null,
    }
    expect(stockRowMatchesTerm(sparse, 'x-1')).toBe(true)
    expect(stockRowMatchesTerm(sparse, 'zzz')).toBe(false)
  })
})
