'use client'

/**
 * PlanningEngineModal — centred zoom-in overlay that replaces the right-rail
 * StandardDrawer / SlideOverPanel for all planning engine surfaces.
 *
 * Width: 60 vw, clamped min-w-[580px] max-w-[780px].
 * Enter: scale(0.94) opacity-0 → scale(1) opacity-1 in 130 ms ease-out.
 * Scrim: 52 % black, click-to-close.
 */

import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/design-system/Button'

export type PlanningEngineModalAction = {
  label: string
  loadingLabel?: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  variant?: 'primary' | 'secondary' | 'danger'
}

type Props = {
  isOpen: boolean
  onClose: () => void
  /** Main title — carton name / PO reference */
  title: ReactNode
  /** Subtitle row beneath the title (PO # · status · customer · badges) */
  metadata?: ReactNode
  /** Sticky bar immediately below the header — used for 5-point readiness strip */
  statusBar?: ReactNode
  children: ReactNode
  primaryAction?: PlanningEngineModalAction
  secondaryAction?: PlanningEngineModalAction
  /** When supplied, replaces the built-in primary / secondary footer row */
  footer?: ReactNode
  /** Extra info shown left side of footer (e.g. last-saved timestamp) */
  footerMeta?: ReactNode
  bodyClassName?: string
  /** Override z-index when stacking multiple modals */
  zIndexClass?: string
  /** Override panel max-width (default: max-w-[780px]) */
  widthClass?: string
}

export function PlanningEngineModal({
  isOpen,
  onClose,
  title,
  metadata,
  statusBar,
  children,
  primaryAction,
  secondaryAction,
  footer: footerOverride,
  footerMeta,
  bodyClassName,
  zIndexClass = 'z-[70]',
  widthClass = 'max-w-[780px]',
}: Props) {
  /* Close on Escape */
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  /* Lock body scroll while open */
  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isOpen])

  if (!isOpen) return null

  const builtInFooter =
    primaryAction || secondaryAction ? (
      <div className="flex w-full items-center gap-3 justify-end">
        {secondaryAction ? (
          <Button
            type="button"
            variant="secondary"
            className="min-h-[38px] min-w-[5.5rem]"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
        {primaryAction ? (
          <Button
            type="button"
            className="min-h-[38px] min-w-[5.5rem]"
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled || primaryAction.loading}
          >
            {primaryAction.loading
              ? (primaryAction.loadingLabel ?? '…')
              : primaryAction.label}
          </Button>
        ) : null}
      </div>
    ) : null

  return (
    <>
      {/* ── Inject keyframe once ── */}
      <style>{`
        @keyframes pe-zoom-in{
          from{opacity:0;transform:scale(.94) translateY(6px)}
          to  {opacity:1;transform:scale(1)   translateY(0)}
        }
        .pe-modal-enter{
          animation:pe-zoom-in 130ms cubic-bezier(.22,.61,.36,1) both;
        }
      `}</style>

      {/* Scrim — sits below the modal panel */}
      <div
        className={cn(
          'fixed inset-0 bg-black/55 backdrop-blur-sm',
          zIndexClass,
        )}
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Modal wrapper — must stack ABOVE the scrim. The previous
          `style={{ zIndex: 'inherit' }}` forced this to z-index:auto,
          letting the scrim paint over the panel and wash it out. */}
      <div
        className={cn(
          'fixed inset-0 flex items-start justify-center overflow-y-auto py-6 px-4',
          zIndexClass,
          'pointer-events-none',
        )}
      >
        <div
          role="dialog"
          aria-modal="true"
          className={cn(
            'pe-modal-enter pointer-events-auto',
            'relative flex flex-col w-[65vw] min-w-[640px]',
            widthClass,
            'rounded-ds-xl border border-ds-line',
            'bg-ds-main shadow-[0_32px_80px_rgba(0,0,0,0.6)]',
            'max-h-[calc(100vh-3rem)] my-auto',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ── */}
          <div className="shrink-0 flex items-start justify-between gap-3 border-b border-ds-line/40 bg-black/35 px-5 py-3.5 rounded-t-ds-xl">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint bg-ds-elevated border border-ds-line/40 px-2 py-0.5 rounded-ds-sm">
                  Planning engine
                </span>
              </div>
              <h2 className="text-sm font-semibold text-ds-ink truncate pr-2 leading-snug">
                {title}
              </h2>
              {metadata ? (
                <div className="mt-1">{metadata}</div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded p-1.5 text-ds-ink-muted hover:bg-ds-elevated hover:text-ds-ink transition-colors"
              aria-label="Close planning engine"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* ── Status bar (5-point readiness strip) ── */}
          {statusBar ? (
            <div className="shrink-0 border-b border-ds-line/40 bg-ds-card/40 px-5 py-2">
              {statusBar}
            </div>
          ) : null}

          {/* ── Scrollable body ── */}
          <div
            className={cn(
              'flex-1 min-h-0 overflow-y-auto px-5 py-4',
              bodyClassName,
            )}
          >
            {children}
          </div>

          {/* ── Footer ── */}
          {(footerOverride ?? builtInFooter) ? (
            <div className="shrink-0 flex items-center justify-between gap-4 border-t border-ds-line/40 bg-black/25 px-5 py-3 rounded-b-ds-xl">
              {footerMeta ? (
                <div className="text-xs text-ds-ink-faint truncate min-w-0 flex-1">
                  {footerMeta}
                </div>
              ) : (
                <div />
              )}
              {footerOverride ?? builtInFooter}
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
