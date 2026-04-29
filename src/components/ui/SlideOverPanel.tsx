'use client'

import { type ReactNode, useEffect } from 'react'
import { cn } from '@/lib/cn'

export type StandardSlideOverOptions = {
  widthClass?: string
  backdropClassName?: string
  panelClassName?: string
  animateEnter?: boolean
}

type SlideOverPanelProps = StandardSlideOverOptions & {
  title: ReactNode
  /** Sticky header: one line of metadata under the title (e.g. PO # · status) */
  headerMeta?: ReactNode
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  /** Sticky footer (primary / secondary actions) */
  footer?: ReactNode
  /** Defaults to `z-[60]`; only one app drawer is active at a time. */
  zIndexClass?: string
}

const DRAWER_RAIL = 'w-[min(100%,clamp(420px,38vw,640px))]'
const PANEL_BASE =
  'border-l border-ds-line/80 bg-ds-card bg-gradient-to-b from-white/[0.04] to-transparent text-ds-ink shadow-ds-drawer'
const HEADER_FOOTER_PAD = 'px-4 py-3 md:px-6'
const BODY_PAD = 'px-4 py-4 md:px-6'

/**
 * Right-side system drawer: 38% width (clamped 420–640px), 100% height, subtle 25% black overlay.
 * Row switching updates children without remount; parent controls `isOpen` + row identity.
 */
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
    <div className={cn('fixed inset-0 flex justify-end', zIndexClass)} role="presentation">
      <button
        type="button"
        aria-label="Close"
        className={cn(backdropClassName, 'absolute inset-0 transition-opacity')}
        onClick={onClose}
      />
      <div
        className={cn(
          'relative z-[1] flex h-full min-h-0 min-w-0 flex-col',
          DRAWER_RAIL,
          PANEL_BASE,
          widthClass,
          panelClassName,
          animateEnter && 'animate-ds-drawer-slide',
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
              <span className="text-lg leading-none" aria-hidden>
                ×
              </span>
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
