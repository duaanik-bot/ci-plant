import { describe, it, expect } from 'vitest'
import { computeRag } from './procurement-rag'

const base = {
  shortage_sheets: 0,
  open_pr_id: null,
  open_pr_status: null,
  hasOpenPo: false,
}

describe('computeRag', () => {
  it('returns green when no shortage', () => {
    expect(computeRag({ ...base, shortage_sheets: 0 })).toBe('green')
  })

  it('returns green when shortage_sheets is negative', () => {
    expect(computeRag({ ...base, shortage_sheets: -100 })).toBe('green')
  })

  it('returns amber when shortage and open PR (not received)', () => {
    expect(computeRag({ ...base, shortage_sheets: 500, open_pr_id: 'pr1', open_pr_status: 'approved' })).toBe('amber')
  })

  it('returns amber when shortage and open PO', () => {
    expect(computeRag({ ...base, shortage_sheets: 500, hasOpenPo: true })).toBe('amber')
  })

  it('returns red when shortage and nothing ordered', () => {
    expect(computeRag({ ...base, shortage_sheets: 500 })).toBe('red')
  })

  it('returns red when shortage and PR is received (closed)', () => {
    expect(computeRag({ ...base, shortage_sheets: 500, open_pr_id: 'pr1', open_pr_status: 'received' })).toBe('red')
  })
})
