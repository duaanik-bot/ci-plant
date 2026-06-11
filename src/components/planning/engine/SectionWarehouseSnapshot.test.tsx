import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SectionWarehouseSnapshot } from './SectionWarehouseSnapshot'
import type { PlanningEngineReadiness } from './types'

const readiness = {
  requiredSheets: 16817,
  reservedSheets: 12000,
  reservedForLine: 10000,
  netRequirement: 6817,
  prQty: 6817,
  availableSheets: 25000,
  freeSheets: 13000,
  openPoQty: 5000,
  incomingSheets: 5000,
  shortageSheets: 6817,
  prStatus: 'pending',
  grnEta: null,
} as unknown as PlanningEngineReadiness

describe('SectionWarehouseSnapshot', () => {
  it('shows only net required, reserved, and PR raised quantities', () => {
    render(<SectionWarehouseSnapshot readiness={readiness} />)

    expect(screen.getByText('Net Required')).toBeInTheDocument()
    expect(screen.getByText('Reserved')).toBeInTheDocument()
    expect(screen.getByText('PR Raised')).toBeInTheDocument()
    expect(screen.getAllByText('6,817 sh')).toHaveLength(2)
    expect(screen.getByText('10,000 sh')).toBeInTheDocument()

    expect(screen.queryByText('Total Stock')).not.toBeInTheDocument()
    expect(screen.queryByText('Free Stock')).not.toBeInTheDocument()
    expect(screen.queryByText('Open PO')).not.toBeInTheDocument()
    expect(screen.queryByText('Incoming')).not.toBeInTheDocument()
  })
})
