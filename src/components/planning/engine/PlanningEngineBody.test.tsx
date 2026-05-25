import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PlanningEngineBody } from './PlanningEngineBody'
import type { PlanningEngineLine } from './types'

const line = {
  id: 'L1',
  quantity: 1000,
  specOverrides: null,
  planningStatus: 'planning',
  cartonId: null,
  cartonName: 'X',
  cartonSize: null,
  artworkCode: null,
  coatingType: null,
  otherCoating: null,
  embossingLeafing: null,
  paperType: null,
  gsm: null,
  remarks: null,
  po: { id: 'PO1', poNumber: 'PO1', poDate: '2026-05-10', customer: { id: 'C1', name: 'X' } },
  smartMatch: null,
  planningLedger: null,
  upsAndSpec: null,
  batchDecision: null,
  materialQueue: null,
  carton: null,
} as unknown as PlanningEngineLine

describe('PlanningEngineBody order', () => {
  it('renders sections in order: Sheet Metrics → Board Allocation → Smart Match → Batch Decision', () => {
    render(
      <PlanningEngineBody
        line={line}
        readiness={null}
        readinessLoading={false}
        onPatch={async () => true}
        onLock={async () => {}}
      />,
    )
    // All four section titles render as plain text via CardSection → SectionLabel
    const titles = screen
      .getAllByText(/^(SHEET METRICS|BOARD ALLOCATION|SMART MATCH|BATCH DECISION)$/i)
      .map((el) => el.textContent?.toUpperCase() ?? '')

    const idx = (frag: string) => titles.findIndex((t) => t.includes(frag))

    expect(idx('SHEET')).toBeLessThan(idx('BOARD'))
    expect(idx('BOARD')).toBeLessThan(idx('SMART'))
    expect(idx('SMART')).toBeLessThan(idx('BATCH'))
  })
})
