'use client'

import { type ReactNode, useEffect, useState } from 'react'
import { cn } from '@/lib/cn'

export type StandardSlideOverOptions = {
  widthClass?: string
  backdropClassName?: string
  panelClassName?: string
  animateEnter?: boolean
}

type SlideOverPanelProps = StandardSlideOverOptions & {
  title: ReactNode
  headerMeta?: ReactNode
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  zIndexClass?: string
}

const DRAWER_RAIL = 'w-[min(100%,clamp(420px,40vw,680px))]'
const PANEL_BASE =
  'border-l border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] shadow-ds-drawer'
const HEADER_FOOTER_PAD = 'px-4 py-3 md:px-6'
const BODY_PAD = 'px-4 py-4 md:px-6'

export function SlideOverPanel({
  title,
  headerMeta,
  isOpen,
  onClose,
  children,
  widthClass,
  backdropClassName = 'bg-[rgba(0,0,0,0.25)]',
  panelClassName,
  footer,
  zIndexClass = 'z-[1100]',
}: SlideOverPanelProps) {
  // `mounted` keeps the DOM alive after close so the exit animation plays
  const [mounted, setMounted] = useState(isOpen)
  const [visible, setVisible] = useState(isOpen)

  useEffect(() => {
    if (isOpen) {
      setMounted(true)
      // tiny delay to let the browser paint before starting the transition
      const raf = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(raf)
    } else {
      setVisible(false)
      // unmount after the 220ms exit transition completes
      const t = setTimeout(() => setMounted(false), 220)
      return () => clearTimeout(t)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!mounted) return null

  return (
    <div
      className={cn('fixed inset-0 flex justify-end', zIndexClass)}
      role="presentation"
      aria-hidden={!isOpen}
    >
      {/* Backdrop — fades in/out */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={cn(
          backdropClassName,
          'absolute inset-0 transition-opacity duration-200',
          visible ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Panel — slides in/out */}
      <div
        className={cn(
          'relative z-[1] flex h-full min-h-0 min-w-0 flex-col',
          'transition-transform duration-200 ease-out',
          visible ? 'translate-x-0' : 'translate-x-full',
          DRAWER_RAIL,
          PANEL_BASE,
          widthClass,
          panelClassName,
        )}
        role="dialog"
        aria-modal="true"
      >
        <header
          className={cn(
            'shrink-0 border-b border-ds-line/25 bg-ds-elevated/60',
            HEADER_FOOTER_PAD,
            'md:pt-5 md:pb-4',
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="ds-typo-heading min-w-0 pr-2">{title}</h2>
              {headerMeta ? (
                <div className="mt-1.5 text-sm leading-snug text-ds-ink-muted">{headerMeta}</div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-ds-sm p-1.5 text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-ink"
              aria-label="Close"
            >
              <span className="text-lg leading-none" aria-hidden>×</span>
            </button>
          </div>
        </header>

        <div className={cn('min-h-0 flex-1 overflow-y-auto overflow-x-hidden', BODY_PAD, 'md:pt-1')}>
          {children}
        </div>

        {footer ? (
          <footer
            className={cn(
              'shrink-0 border-t border-ds-line/30 bg-ds-elevated/60',
              HEADER_FOOTER_PAD,
              'pt-4 shadow-ds-drawer-foot',
            )}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
