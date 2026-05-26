import { describe, it, expect } from 'vitest'
import { prModeForRow, eligibleForBulkPr } from './procurement-row-actions'

describe('prModeForRow', () => {
  it('uses shortage flow when there is an open shortage and no PR', () => {
    expect(prModeForRow({ shortage_sheets: 500, open_pr_id: null })).toBe('shortage')
  })

  it('uses manual flow when there is no shortage', () => {
    expect(prModeForRow({ shortage_sheets: 0, open_pr_id: null })).toBe('manual')
  })

  it('uses manual flow when a PR already exists, even with shortage', () => {
    expect(prModeForRow({ shortage_sheets: 500, open_pr_id: 'pr-1' })).toBe('manual')
  })
})

describe('eligibleForBulkPr', () => {
  it('includes rows with shortage and no PR', () => {
    expect(eligibleForBulkPr({ shortage_sheets: 500, open_pr_id: null })).toBe(true)
  })

  it('excludes rows with no shortage', () => {
    expect(eligibleForBulkPr({ shortage_sheets: 0, open_pr_id: null })).toBe(false)
  })

  it('excludes rows that already have a PR', () => {
    expect(eligibleForBulkPr({ shortage_sheets: 500, open_pr_id: 'pr-1' })).toBe(false)
  })
})
