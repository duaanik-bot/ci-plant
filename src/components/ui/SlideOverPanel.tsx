'use client'

import { ReactNode, useEffect } from 'react'

type SlideOverPanelProps = {
  title: string
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  widthClass?: string
  /** Backdrop (full-screen button) classes */
  backdropClassName?: string
  /** Panel container classes (glass, border, etc.). */
  panelClassName?: string
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
    <div className="fixed inset-0 z-[60] flex justify-end">
      <button
        type="button"
        aria-label="Close"
        className={`absolute inset-0 ${backdropClassName} backdrop-blur-[2px]`}
        onClick={onClose}
      />
      <div
        className={`relative h-full w-full ${widthClass} flex flex-col ${panelClassName} ${
          animateEnter ? 'animate-slide-over-enter' : ''
        }`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0">
          <h2 className="text-sm font-semibold text-card-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>
  )
}

