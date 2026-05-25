'use client'

import { X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/design-system/Button'
import { cn } from '@/lib/cn'

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'fullscreen'

export type ModalAction = {
  label: string
  loadingLabel?: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
}

export type GlobalPopoutModalProps = {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  /** Secondary line under the title (customer · status · value · date · stage). */
  metadata?: ReactNode
  children: ReactNode
  size?: ModalSize
  /**
   * 'preview' = light read-only popups: backdrop-click AND Escape close.
   * 'form'    = editors/forms: backdrop-click never closes; Escape closes only
   *             when hasUnsavedChanges is false.
   */
  mode?: 'preview' | 'form'
  hasUnsavedChanges?: boolean
  primaryAction?: ModalAction
  secondaryAction?: ModalAction
  /** Replaces the built-in primary/secondary action row. */
  footer?: ReactNode
  bodyClassName?: string
  /** Width override (e.g. migrated SlideOverPanel widthClass). Wins over size. */
  widthClass?: string
  zIndexClass?: string
}

const SIZE_MAX_WIDTH: Record<ModalSize, string> = {
  sm: 'sm:max-w-[420px]',
  md: 'sm:max-w-[640px]',
  lg: 'sm:max-w-[900px]',
  xl: 'sm:max-w-[1180px]',
  fullscreen: 'sm:max-w-[95vw]',
}

export function GlobalPopoutModal({
  isOpen,
  onClose,
  title,
  metadata,
  children,
  size = 'md',
  mode = 'form',
  hasUnsavedChanges = false,
  primaryAction,
  secondaryAction,
  footer: footerOverride,
  bodyClassName,
  widthClass,
  zIndexClass = 'z-[1100]',
}: GlobalPopoutModalProps) {
  const titleId = useId()
  // mounted keeps the DOM alive after close so the 220ms exit animation can play.
  const [mounted, setMounted] = useState(isOpen)
  const [visible, setVisible] = useState(isOpen)
  const panelRef = useRef<HTMLDivElement>(null)
  const lastFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (isOpen) {
      setMounted(true)
      const raf = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(raf)
    }
    setVisible(false)
    const t = setTimeout(() => setMounted(false), 220)
    return () => clearTimeout(t)
  }, [isOpen])

  // Body scroll lock while open.
  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isOpen])

  // Focus management: remember trigger, focus the panel on open, restore on close/unmount.
  useEffect(() => {
    if (!isOpen) return
    lastFocused.current = document.activeElement as HTMLElement | null
    const raf = requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      lastFocused.current?.focus?.()
    }
  }, [isOpen])

  // Escape handling honoring mode + unsaved changes.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (mode === 'form' && hasUnsavedChanges) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, mode, hasUnsavedChanges, onClose])

  // Focus trap: keep Tab/Shift+Tab within the panel.
  function handleTrapKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return
    const root = panelRef.current
    if (!root) return
    const focusables = root.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) {
      e.preventDefault()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    // Focus sitting on the panel itself (or otherwise outside the list) — pull it back in.
    if (active === root || !root.contains(active)) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
      return
    }
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  if (!mounted) return null

  const handleBackdropClick = () => {
    if (mode === 'preview') onClose()
  }

  const builtInFooter =
    primaryAction || secondaryAction ? (
      <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
        {secondaryAction ? (
          <Button
            type="button"
            variant="secondary"
            className="min-h-[40px] min-w-[6rem] flex-1 sm:flex-initial"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
        {primaryAction ? (
          <Button
            type="button"
            className="min-h-[40px] min-w-[6rem] flex-1 sm:flex-initial"
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled || primaryAction.loading}
          >
            {primaryAction.loading ? (primaryAction.loadingLabel ?? '…') : primaryAction.label}
          </Button>
        ) : null}
      </div>
    ) : null

  const footer = footerOverride ?? builtInFooter

  return (
    <div
      className={cn(
        'fixed inset-0 flex items-end justify-center sm:items-center sm:p-4',
        zIndexClass,
      )}
      role="presentation"
      aria-hidden={!isOpen}
    >
      {/* Backdrop — dimmed + blurred, fades in/out. Decorative; X button is the a11y close. */}
      <div
        data-testid="gpm-backdrop"
        aria-hidden="true"
        onClick={handleBackdropClick}
        className={cn(
          'absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-200',
          visible ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Panel — centered, scales + fades in/out. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleTrapKeyDown}
        className={cn(
          'relative z-[1] flex w-full flex-col outline-none',
          'max-h-[100dvh] rounded-t-ds-lg sm:max-h-[88vh] sm:w-[90vw] sm:rounded-ds-lg',
          'bg-ds-card text-ds-ink shadow-ds-drawer',
          'transition-all duration-200 ease-out',
          visible
            ? 'translate-y-0 opacity-100 sm:scale-100'
            : 'translate-y-4 opacity-0 sm:translate-y-0 sm:scale-95',
          SIZE_MAX_WIDTH[size],
          widthClass,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-ds-line/25 bg-ds-elevated/60 px-4 py-3 md:px-6 md:pb-4 md:pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="ds-typo-heading min-w-0 pr-2">{title}</h2>
            {metadata ? (
              <div className="mt-1.5 text-sm leading-snug text-ds-ink-muted">{metadata}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-ds-sm p-1.5 text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div
          className={cn(
            'min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 text-sm text-ds-ink md:px-6',
            bodyClassName,
          )}
        >
          {children}
        </div>

        {footer ? (
          <footer className="shadow-ds-drawer-foot shrink-0 border-t border-ds-line/30 bg-ds-elevated/60 px-4 py-3 md:px-6 md:pt-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
