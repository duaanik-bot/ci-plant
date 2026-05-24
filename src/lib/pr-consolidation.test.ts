import { describe, it, expect } from 'vitest'
import { consolidatePrs, type ConsolidatablePr } from './pr-consolidation'

const base: Omit<ConsolidatablePr, 'id' | 'qty'> = {
  materialId: 'mat-duplex',
  materialCode: 'DPX-230',
  boardType: 'Duplex',
  gsm: 230,
  sizeLabel: '20x30',
  supplierId: 'sup-a',
  requiredByDate: '2026-05-24',
}

describe('consolidatePrs', () => {
  it('merges PRs that share material|board|gsm|size into one group with summed qty', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 10000 },
      { ...base, id: 'pr2', qty: 8000 },
      { ...base, id: 'pr3', qty: 12000 },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.totalQty).toBe(30000)
    expect(groups[0]!.members.map((m) => m.prId).sort()).toEqual(['pr1', 'pr2', 'pr3'])
  })

  it('merges across different vendors and suggests the most common supplier', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 10000, supplierId: 'sup-a' },
      { ...base, id: 'pr2', qty: 8000, supplierId: 'sup-b' },
      { ...base, id: 'pr3', qty: 12000, supplierId: 'sup-a' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.suggestedSupplierId).toBe('sup-a')
  })

  it('separates PRs that differ on any grouping field', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 10000, gsm: 230 },
      { ...base, id: 'pr2', qty: 8000, gsm: 300 },
      { ...base, id: 'pr3', qty: 5000, boardType: 'SBS' },
    ])
    expect(groups).toHaveLength(3)
  })

  it('picks the earliest required date for the group', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 1, requiredByDate: '2026-06-01' },
      { ...base, id: 'pr2', qty: 1, requiredByDate: '2026-05-20' },
    ])
    expect(groups[0]!.earliestRequiredDate).toBe('2026-05-20')
  })

  it('handles a single PR and a null supplier/date gracefully', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 500, supplierId: null, requiredByDate: null },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.totalQty).toBe(500)
    expect(groups[0]!.suggestedSupplierId).toBeNull()
    expect(groups[0]!.earliestRequiredDate).toBeNull()
  })

  it('returns an empty array for empty input', () => {
    expect(consolidatePrs([])).toEqual([])
  })

  it('does not collide when a field value contains the separator character', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 1, sizeLabel: '20|30', boardType: 'Duplex', gsm: 230 },
      { ...base, id: 'pr2', qty: 1, sizeLabel: '20', boardType: '30|Duplex', gsm: 230 },
    ])
    expect(groups).toHaveLength(2)
  })

  it('treats null and empty-string board type as distinct groups', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 1, boardType: null },
      { ...base, id: 'pr2', qty: 1, boardType: '' },
    ])
    expect(groups).toHaveLength(2)
  })

  it('keeps the first-seen supplier on a tie (deterministic by input order)', () => {
    const groups = consolidatePrs([
      { ...base, id: 'pr1', qty: 1, supplierId: 'sup-b' },
      { ...base, id: 'pr2', qty: 1, supplierId: 'sup-a' },
    ])
    expect(groups[0]!.suggestedSupplierId).toBe('sup-b')
  })
})
