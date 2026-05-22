import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SlideOverPanel } from './SlideOverPanel'

describe('SlideOverPanel (centered-modal adapter)', () => {
  it('renders title and children as a centered dialog', () => {
    render(
      <SlideOverPanel isOpen title="Drawer Title" onClose={() => {}}>
        <p>Drawer body</p>
      </SlideOverPanel>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('Drawer Title')).toBeInTheDocument()
    expect(screen.getByText('Drawer body')).toBeInTheDocument()
    // centered, not a right-rail slide-in
    expect(dialog.className).toContain('-translate-x-1/2')
    expect(dialog.className).not.toContain('translate-x-full')
  })
})
