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
  widthClass = 'w-[min(40vw,32rem)] max-w-full',
  backdropClassName = 'bg-[#0B1220]/70 backdrop-blur-[2px]',
  panelClassName = 'border-l border-ds-line bg-ds-card text-ds-ink shadow-2xl',
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
        <div className="flex shrink-0 items-center justify-between border-b border-ds-line/80 bg-ds-elevated/60 px-4 py-3 shadow-sm">
          <h2 className="ds-typo-heading min-w-0 pr-2">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-ds-sm px-2 py-1 text-sm text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-ink"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">{children}</div>
        {footer ? (
          <div className="shrink-0 border-t border-ds-line/80 bg-ds-elevated/50 px-4 py-3 shadow-[0_-4px_24px_rgba(0,0,0,0.12)]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}

