import { describe, it, expect } from 'vitest'
import {
  dbStatusToUiStage,
  uiStageToDbStatus,
  mapFilterToDbStatuses,
} from './purchase-requisition-status'

describe('purchase-requisition-status', () => {
  it('maps the new ordered db status to the ordered UI stage', () => {
    expect(dbStatusToUiStage('ordered')).toBe('ordered')
  })

  it('still maps converted_to_po to the ordered UI stage', () => {
    expect(dbStatusToUiStage('converted_to_po')).toBe('ordered')
  })

  it('maps received and approved correctly', () => {
    expect(dbStatusToUiStage('received')).toBe('received')
    expect(dbStatusToUiStage('approved')).toBe('approved')
    expect(dbStatusToUiStage('pending')).toBe('draft')
    expect(dbStatusToUiStage(null)).toBe('draft')
  })

  it('converts the ordered UI stage to the awaiting-PO ordered db status', () => {
    expect(uiStageToDbStatus('ordered')).toBe('ordered')
    expect(uiStageToDbStatus('approved')).toBe('approved')
    expect(uiStageToDbStatus('received')).toBe('received')
    expect(uiStageToDbStatus('draft')).toBe('pending')
  })

  it('filter for ordered includes both ordered and converted_to_po', () => {
    expect(mapFilterToDbStatuses('ordered')).toEqual(['ordered', 'converted_to_po'])
    expect(mapFilterToDbStatuses('converted_to_po')).toEqual(['ordered', 'converted_to_po'])
  })
})
