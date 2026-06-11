import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SpecPackPanel } from './SpecPackPanel'
import { emptySpecPack } from '@/lib/carton-spec-pack'

describe('SpecPackPanel', () => {
  it('renders legacy notice when no pack', () => {
    render(<SpecPackPanel specPack={null} specOverrides={null} />)
    expect(screen.getByText(/no locked spec pack/i)).toBeInTheDocument()
  })

  it('renders grouped values from the pack', () => {
    const p = emptySpecPack('c1', 'APEG ORAL')
    p.board.boardGrade = 'SBS'
    p.board.gsm = 350
    p.sheet.ups = 6
    render(<SpecPackPanel specPack={p} specOverrides={null} />)
    expect(screen.getByText('Saffire')).toBeInTheDocument()
    expect(screen.getByText('350')).toBeInTheDocument()
    expect(screen.getByText('6')).toBeInTheDocument()
  })

  it('marks overridden fields', () => {
    const p = emptySpecPack('c1', 'X')
    p.board.gsm = 300
    render(
      <SpecPackPanel
        specPack={p}
        specOverrides={{ specPack: { board: { gsm: 350 } } }}
      />,
    )
    expect(screen.getByText('350')).toBeInTheDocument()
    expect(screen.getByText(/overridden/i)).toBeInTheDocument()
  })
})
