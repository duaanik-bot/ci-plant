import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { GlobalPopoutModal } from './GlobalPopoutModal'

afterEach(() => {
  document.body.style.overflow = ''
})

function setup(props: Partial<React.ComponentProps<typeof GlobalPopoutModal>> = {}) {
  const onClose = vi.fn()
  render(
    <GlobalPopoutModal isOpen onClose={onClose} title="PO SGB/2627" {...props}>
      <p>Body content</p>
    </GlobalPopoutModal>,
  )
  return { onClose }
}

describe('GlobalPopoutModal', () => {
  it('renders title and children when open', () => {
    setup()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('PO SGB/2627')).toBeInTheDocument()
    expect(screen.getByText('Body content')).toBeInTheDocument()
  })

  it('renders nothing when closed', () => {
    const onClose = vi.fn()
    render(
      <GlobalPopoutModal isOpen={false} onClose={onClose} title="Hidden">
        <p>Body content</p>
      </GlobalPopoutModal>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders the optional metadata row', () => {
    setup({ metadata: <span>Acme · ₹1,20,000</span> })
    expect(screen.getByText('Acme · ₹1,20,000')).toBeInTheDocument()
  })

  it('close button (X) always closes', () => {
    const { onClose } = setup({ mode: 'form', hasUnsavedChanges: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preview mode: Escape closes', () => {
    const { onClose } = setup({ mode: 'preview' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preview mode: backdrop click closes', () => {
    const { onClose } = setup({ mode: 'preview' })
    fireEvent.click(screen.getByTestId('gpm-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('form mode: backdrop click does NOT close', () => {
    const { onClose } = setup({ mode: 'form' })
    fireEvent.click(screen.getByTestId('gpm-backdrop'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('form mode: Escape closes when there are no unsaved changes', () => {
    const { onClose } = setup({ mode: 'form', hasUnsavedChanges: false })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('form mode: Escape does NOT close when there are unsaved changes', () => {
    const { onClose } = setup({ mode: 'form', hasUnsavedChanges: true })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders primary and secondary actions and fires their handlers', () => {
    const onPrimary = vi.fn()
    const onSecondary = vi.fn()
    setup({
      primaryAction: { label: 'Save', onClick: onPrimary },
      secondaryAction: { label: 'Cancel', onClick: onSecondary },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(onSecondary).toHaveBeenCalledTimes(1)
  })

  it('locks body scroll while open', () => {
    setup()
    expect(document.body.style.overflow).toBe('hidden')
  })
})
