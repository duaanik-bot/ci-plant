import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SectionWarehouseAvailability } from './SectionWarehouseAvailability'
import type { PlanningEngineReadiness } from './types'

const readiness = {
  materialId: 'm1', materialCode: 'ITC-FBB-300', boardType: 'FBB', gsm: 300, size: '760x1020',
  requiredSheets: 5000, availableSheets: 6000, reservedSheets: 1000, freeSheets: 5000,
  incomingSheets: 0, shortageSheets: 0, prStatus: 'not_created', status: 'green',
} as unknown as PlanningEngineReadiness

describe('SectionWarehouseAvailability', () => {
  it('renders available, reserved, free and shortage counts', () => {
    render(<SectionWarehouseAvailability readiness={readiness} />)
    expect(screen.getByText('Available')).toBeInTheDocument()
    expect(screen.getByText('Reserved')).toBeInTheDocument()
    expect(screen.getByText('Free')).toBeInTheDocument()
    expect(screen.getByText('Shortage')).toBeInTheDocument()
    expect(screen.getByText('ITC-FBB-300')).toBeInTheDocument()
  })

  it('fires onOpenWarehouse when the button is clicked', () => {
    const onOpen = vi.fn()
    render(<SectionWarehouseAvailability readiness={readiness} onOpenWarehouse={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /open warehouse/i }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('omits the button when onOpenWarehouse is not provided', () => {
    render(<SectionWarehouseAvailability readiness={readiness} />)
    expect(screen.queryByRole('button', { name: /open warehouse/i })).toBeNull()
  })

  it('renders gracefully when readiness is null', () => {
    render(<SectionWarehouseAvailability readiness={null} />)
    expect(screen.getByText('Available')).toBeInTheDocument()
  })
})
