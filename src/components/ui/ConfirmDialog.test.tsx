import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(() => {
  document.body.style.overflow = ''
})

describe('ConfirmDialog', () => {
  it('renders as a centered dialog with title, message and actions when open', () => {
    render(
      <ConfirmDialog
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Delete Customer"
        message="This cannot be undone."
        confirmLabel="Yes, Delete"
      />,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Delete Customer')).toBeInTheDocument()
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Yes, Delete' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('fires onConfirm and onClose from the action buttons', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <ConfirmDialog open onClose={onClose} onConfirm={onConfirm} confirmLabel="Yes" cancelLabel="No" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when closed', () => {
    render(<ConfirmDialog open={false} onClose={vi.fn()} onConfirm={vi.fn()} title="X" />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
