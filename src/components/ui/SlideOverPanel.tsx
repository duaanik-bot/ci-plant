'use client'

import { type ReactNode, useEffect } from 'react'

type SlideOverPanelProps = {
  title: ReactNode
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  widthClass?: string
  /** Backdrop (full-screen button) classes */
  backdropClassName?: string
  /** Panel container classes (glass, border, etc.). */
  panelClassName?: string
  /** Sticky footer below the scroll area (e.g. primary actions). */
  footer?: ReactNode
  /** Defaults to `z-[60]`; raise when multiple stacked panels need ordering. */
  zIndexClass?: string
  /** Animate panel from the right (200ms ease-in-out) */
  animateEnter?: boolean
}

export function SlideOverPanel({
  title,
  isOpen,
  onClose,
  children,
  widthClass = 'max-w-xl',
  backdropClassName = 'bg-background/60',
  panelClassName = 'border-l border-border bg-card text-card-foreground shadow-xl',
  footer,
  zIndexClass = 'z-[60]',
  animateEnter = true,
}: SlideOverPanelProps) {
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className={`fixed inset-0 ${zIndexClass} flex justify-end`}>
      <button
        type="button"
        aria-label="Close"
        className={`absolute inset-0 ${backdropClassName} backdrop-blur-[2px] transition-opacity`}
        onClick={onClose}
      />
      <div
        className={`relative h-full w-full min-w-0 max-w-full ${widthClass} flex flex-col ${panelClassName} ${
          animateEnter ? 'animate-slide-over-enter' : ''
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="min-w-0 text-sm font-semibold text-card-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">{children}</div>
        {footer ? <div className="shrink-0 border-t border-border bg-card px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  )
}

