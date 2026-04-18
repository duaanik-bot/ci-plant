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
  /** Panel container classes (glass, border, etc.) — default pure black for color-accurate previews */
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
  backdropClassName = 'bg-black/50',
  panelClassName = 'border-l border-zinc-800 bg-[#000000] shadow-xl',
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
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/80 shrink-0">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white text-sm px-2 py-1 rounded"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>
  )
}

