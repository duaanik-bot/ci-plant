'use client'

import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Modal
 * ──────
 * Animated, accessible modal dialog.
 *
 * Features:
 *  • Backdrop blur  (bg-black/40 backdrop-blur-sm)
 *  • Scale-in entry animation
 *  • Escape key closes
 *  • Click-outside closes
 *  • Scrollable body for long content
 *  • Sizes: sm (448px) | md (576px) | lg (672px) | xl (896px) | full (95vw)
 *
 * Usage:
 *   const [open, setOpen] = useState(false)
 *   <Button onClick={() => setOpen(true)}>Open</Button>
 *   <Modal open={open} onClose={() => setOpen(false)} title="Edit Customer" size="lg">
 *     <MyForm />
 *   </Modal>
 */

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full'

const SIZES: Record<ModalSize, string> = {
  sm:   'max-w-md',
  md:   'max-w-xl',
  lg:   'max-w-2xl',
  xl:   'max-w-4xl',
  full: 'max-w-[95vw]',
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  size?: ModalSize
}

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  // Keyboard: Escape → close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Body scroll lock
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    else       document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">

      {/* ── Backdrop ── */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-in fade-in-0 duration-150"
        onClick={onClose}
      />

      {/* ── Panel ── */}
      <div
        className={cn(
          'relative w-full',
          SIZES[size],
          'bg-ds-card rounded-ds-lg shadow-modal',
          'flex flex-col max-h-[90vh]',
          'animate-in scale-in duration-200',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ds-line shrink-0">
          <h2 className="text-base font-semibold text-ds-ink">{title}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-ds-ink hover:bg-ds-elevated transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
      </div>
    </div>
  )
}

export default Modal
