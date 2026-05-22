import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SlideOverPanel } from './SlideOverPanel'

afterEach(() => {
  document.body.style.overflow = ''
})

describe('SlideOverPanel (modal adapter)', () => {
  it('renders as a centered dialog with title, headerMeta and children', () => {
    render(
      <SlideOverPanel isOpen onClose={vi.fn()} title="PO 123" headerMeta={<span>Acme</span>}>
        <p>Lines</p>
      </SlideOverPanel>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('PO 123')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Lines')).toBeInTheDocument()
  })

  it('preserves legacy behavior: backdrop click closes (preview mode)', () => {
    const onClose = vi.fn()
    render(
      <SlideOverPanel isOpen onClose={onClose} title="PO 123">
        <p>Lines</p>
      </SlideOverPanel>,
    )
    fireEvent.click(screen.getByTestId('gpm-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preserves legacy behavior: Escape closes', () => {
    const onClose = vi.fn()
    render(
      <SlideOverPanel isOpen onClose={onClose} title="PO 123">
        <p>Lines</p>
      </SlideOverPanel>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders an optional footer', () => {
    render(
      <SlideOverPanel isOpen onClose={vi.fn()} title="PO 123" footer={<button>Do it</button>}>
        <p>Lines</p>
      </SlideOverPanel>,
    )
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument()
  })
})
