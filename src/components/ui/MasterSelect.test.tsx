import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MasterSelect } from './MasterSelect'
import { MASTER } from '@/lib/masters/registry'

vi.mock('@/components/masters/MastersProvider', () => ({
  useMaster: () => ({
    options: [
      { code: 'NOS', label: 'Numbers' },
      { code: 'KG', label: 'Kilogram' },
    ],
    loading: false,
  }),
}))

describe('MasterSelect', () => {
  it('renders labels but keeps codes as option values', () => {
    render(<MasterSelect masterKey={MASTER.UNIT} value="KG" onChange={() => {}} />)
    const opt = screen.getByRole('option', { name: 'Kilogram' }) as HTMLOptionElement
    expect(opt.value).toBe('KG')
  })
  it('preserves an unknown stored code so old records do not lose data', () => {
    render(<MasterSelect masterKey={MASTER.UNIT} value="LEGACY_X" onChange={() => {}} />)
    expect(screen.getByRole('option', { name: 'LEGACY_X' })).toBeTruthy()
  })
})
