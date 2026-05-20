'use client'

/**
 * PlanningEngineModal — centred zoom-in overlay used for all planning engine
 * surfaces. Explicit light/dark colors (no opacity tokens) so the panel reads
 * as a solid card on either theme.
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
  title: ReactNode
  metadata?: ReactNode
  statusBar?: ReactNode
  children: ReactNode
  primaryAction?: PlanningEngineModalAction
  secondaryAction?: PlanningEngineModalAction
  footer?: ReactNode
  footerMeta?: ReactNode
  bodyClassName?: string
  zIndexClass?: string
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
  zIndexClass = 'z-[200]',
  widthClass = 'max-w-[1200px]',
}: Props) {
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

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
            className="min-h-[40px] min-w-[6rem] text-sm"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
        {primaryAction ? (
          <Button
            type="button"
            className="min-h-[40px] min-w-[6rem] text-sm font-semibold"
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
      <style>{`
        @keyframes pe-zoom-in{
          from{opacity:0;transform:scale(.96) translateY(8px)}
          to  {opacity:1;transform:scale(1)   translateY(0)}
        }
        .pe-modal-enter{
          animation:pe-zoom-in 160ms cubic-bezier(.22,.61,.36,1) both;
        }
      `}</style>

      {/* Scrim — solid 70% black, no blur (keeps the modal crisp) */}
      <div
        className={cn('fixed inset-0 bg-black/70', zIndexClass)}
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Modal container */}
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
            'relative flex flex-col w-[88vw] min-w-[820px]',
            widthClass,
            'rounded-xl border-2 border-slate-300 dark:border-slate-700',
            // Explicit, fully opaque surfaces — no token alpha indirection.
            'bg-white dark:bg-slate-900',
            'shadow-[0_30px_80px_rgba(0,0,0,0.55)]',
            'max-h-[calc(100vh-3rem)] my-auto',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ── */}
          <div className="shrink-0 flex items-start justify-between gap-3 border-b-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-6 py-4 rounded-t-xl">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-orange-700 dark:text-orange-300 bg-orange-100 dark:bg-orange-900/30 border border-orange-300 dark:border-orange-700/50 px-2.5 py-1 rounded">
                  Planning engine
                </span>
              </div>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate pr-2 leading-tight">
                {title}
              </h2>
              {metadata ? (
                <div className="mt-2 text-slate-600 dark:text-slate-400">
                  {metadata}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md p-2 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
              aria-label="Close planning engine"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* ── Status bar ── */}
          {statusBar ? (
            <div className="shrink-0 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-6 py-3 text-sm">
              {statusBar}
            </div>
          ) : null}

          {/* ── Scrollable body ── */}
          <div
            className={cn(
              'flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-slate-950/50 px-6 py-5',
              bodyClassName,
            )}
          >
            {children}
          </div>

          {/* ── Footer ── */}
          {(footerOverride ?? builtInFooter) ? (
            <div className="shrink-0 flex items-center justify-between gap-4 border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-6 py-3.5 rounded-b-xl">
              {footerMeta ? (
                <div className="text-xs text-slate-600 dark:text-slate-400 truncate min-w-0 flex-1">
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
