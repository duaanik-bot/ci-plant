import { describe, it, expect } from 'vitest'
import { summariseInboxItems, isAllDone, type RawInboxItem } from './po-import-inbox'

function makeItem(overrides: Partial<RawInboxItem> = {}): RawInboxItem {
  return {
    id: overrides.id ?? 'i1',
    filename: overrides.filename ?? 'po.pdf',
    status: overrides.status ?? 'ready',
    errorMessage: overrides.errorMessage ?? null,
    committedPoId: overrides.committedPoId ?? null,
    detection: overrides.detection ?? null,
    extracted: overrides.extracted ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-05-20T10:00:00Z'),
  }
}

describe('summariseInboxItems', () => {
  it('preserves a strict 1-to-1 mapping — N PDFs in, N rows out', () => {
    const items: RawInboxItem[] = [
      makeItem({ id: 'a', filename: 'saachi_1.pdf', extracted: { poNumber: 'SAA/2026/001', lineItems: [{}, {}] } }),
      makeItem({ id: 'b', filename: 'saachi_2.pdf', extracted: { poNumber: 'SAA/2026/002', lineItems: [{}] } }),
      makeItem({ id: 'c', filename: 'pureflix_a.pdf', extracted: { poNumber: 'PF-9988', lineItems: [{}, {}, {}] } }),
      makeItem({ id: 'd', filename: 'pureflix_b.pdf', extracted: { poNumber: 'PF-9989', lineItems: [{}] } }),
      makeItem({ id: 'e', filename: 'darbi_x.pdf', extracted: { poNumber: 'DAR/24', lineItems: [{}, {}] } }),
    ]
    const out = summariseInboxItems(items)
    expect(out).toHaveLength(5)
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    // Each row keeps its OWN poNumber — no merging across files.
    expect(out.map((o) => o.poNumber)).toEqual([
      'SAA/2026/001',
      'SAA/2026/002',
      'PF-9988',
      'PF-9989',
      'DAR/24',
    ])
    // No duplicates flagged when every poNumber is distinct.
    expect(out.every((o) => o.duplicateOf === null)).toBe(true)
  })

  it('flags duplicate poNumbers across items in the same batch', () => {
    const items: RawInboxItem[] = [
      makeItem({ id: '1', filename: 'first.pdf', extracted: { poNumber: 'PO-100' } }),
      makeItem({ id: '2', filename: 'second.pdf', extracted: { poNumber: 'PO-200' } }),
      // Same poNumber as item 1 — likely an accidental re-upload.
      makeItem({ id: '3', filename: 'dup.pdf', extracted: { poNumber: 'PO-100' } }),
      // Case + whitespace insensitive — still a dup of 1.
      makeItem({ id: '4', filename: 'dup2.pdf', extracted: { poNumber: ' po-100 ' } }),
    ]
    const out = summariseInboxItems(items)
    expect(out[0].duplicateOf).toBeNull()
    expect(out[1].duplicateOf).toBeNull()
    expect(out[2].duplicateOf).toBe('first.pdf')
    expect(out[3].duplicateOf).toBe('first.pdf')
  })

  it('extracts customer name from a matched roster row', () => {
    const out = summariseInboxItems([
      makeItem({
        detection: { matchedCustomerName: 'Saachi Group Pvt Ltd', confidence: 0.95 },
      }),
    ])
    expect(out[0].customerName).toBe('Saachi Group Pvt Ltd')
    expect(out[0].customerConfidence).toBe(0.95)
  })

  it('falls back to newCustomerProposal.name when no roster match', () => {
    const out = summariseInboxItems([
      makeItem({
        detection: { newCustomerProposal: { name: 'Brand New Co.' }, confidence: 0 },
      }),
    ])
    expect(out[0].customerName).toBe('Brand New Co.')
  })

  it('handles missing detection / extracted JSON without crashing', () => {
    const out = summariseInboxItems([
      makeItem({ status: 'pending' }),
      makeItem({ status: 'extracting' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].poNumber).toBeNull()
    expect(out[0].lineCount).toBeNull()
    expect(out[0].customerName).toBeNull()
    expect(out[0].duplicateOf).toBeNull()
  })

  it('does NOT flag pending/extracting items as duplicates (poNumber is null)', () => {
    // Two pending items with no extracted JSON yet must not be flagged.
    const out = summariseInboxItems([
      makeItem({ id: '1', filename: 'a.pdf', status: 'pending' }),
      makeItem({ id: '2', filename: 'b.pdf', status: 'pending' }),
    ])
    expect(out.every((o) => o.duplicateOf === null)).toBe(true)
  })
})

describe('isAllDone', () => {
  it('true only when every item has reached a terminal status', () => {
    expect(isAllDone([{ status: 'ready' }, { status: 'committed' }, { status: 'failed' }])).toBe(true)
    expect(isAllDone([{ status: 'ready' }, { status: 'extracting' }])).toBe(false)
    expect(isAllDone([{ status: 'pending' }])).toBe(false)
    expect(isAllDone([])).toBe(true)
  })
})
