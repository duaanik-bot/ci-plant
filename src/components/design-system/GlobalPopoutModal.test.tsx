import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { GlobalPopoutModal } from './GlobalPopoutModal'

describe('GlobalPopoutModal', () => {
  it('renders title and children when open', () => {
    render(
      <GlobalPopoutModal isOpen onClose={() => {}} title="PO Detail" size="xl">
        <p>Body content</p>
      </GlobalPopoutModal>,
    )
    expect(screen.getByText('PO Detail')).toBeInTheDocument()
    expect(screen.getByText('Body content')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders nothing when closed', () => {
    render(
      <GlobalPopoutModal isOpen={false} onClose={() => {}} title="Hidden">
        <p>Body content</p>
      </GlobalPopoutModal>,
    )
    expect(screen.queryByText('Body content')).not.toBeInTheDocument()
  })

  it('calls onClose on Escape', async () => {
    const onClose = vi.fn()
    render(
      <GlobalPopoutModal isOpen onClose={onClose} title="Closable">
        <p>x</p>
      </GlobalPopoutModal>,
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('applies the size width class', () => {
    render(
      <GlobalPopoutModal isOpen onClose={() => {}} title="Sized" size="sm">
        <p>x</p>
      </GlobalPopoutModal>,
    )
    expect(screen.getByRole('dialog').className).toContain('max-w-[420px]')
  })
})
