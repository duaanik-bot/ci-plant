'use client'

import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

export type GlobalPopoutModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'fullscreen'

const SIZE_CLASS: Record<GlobalPopoutModalSize, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[640px]',
  lg: 'max-w-[900px]',
  xl: 'max-w-[1180px]',
  fullscreen: 'max-w-[95vw]',
}

export type GlobalPopoutModalProps = {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  /** Secondary line under the title */
  metadata?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: GlobalPopoutModalSize
  /** Escape hatch for legacy adapters that pass an explicit width class */
  widthClass?: string
  bodyClassName?: string
  panelClassName?: string
}

/**
 * Application-standard centered pop-out. Single source of truth for all detail views,
 * edit forms, approvals and workflow interactions. Built on Radix Dialog (focus trap,
 * scroll lock, ESC, focus restore are native). Sticky header + footer; body-only scroll.
 */
export function GlobalPopoutModal({
  isOpen,
  onClose,
  title,
  metadata,
  children,
  footer,
  size = 'md',
  widthClass,
  bodyClassName,
  panelClassName,
}: GlobalPopoutModalProps) {
  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[1100] bg-[rgba(0,0,0,0.45)] backdrop-blur-[2px]',
            'data-[state=open]:animate-ds-overlay-in data-[state=closed]:animate-ds-overlay-out',
          )}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-[1101] flex max-h-[90vh] w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col',
            'overflow-hidden rounded-ds-modal border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] shadow-ds-drawer',
            'data-[state=open]:animate-ds-modal-in data-[state=closed]:animate-ds-modal-out',
            size === 'fullscreen' ? 'h-[95vh]' : '',
            widthClass ?? SIZE_CLASS[size],
            panelClassName,
          )}
        >
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-ds-line/25 bg-ds-elevated/60 px-4 py-3 md:px-6 md:pt-5 md:pb-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="ds-typo-heading min-w-0 pr-2">{title}</Dialog.Title>
              {metadata ? (
                <div className="mt-1.5 text-sm leading-snug text-ds-ink-muted">{metadata}</div>
              ) : null}
            </div>
            <Dialog.Close
              className="shrink-0 rounded-ds-sm p-1.5 text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-ink"
              aria-label="Close"
            >
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </header>

          <div className={cn('min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 text-sm text-ds-ink md:px-6', bodyClassName)}>
            {children}
          </div>

          {footer ? (
            <footer className="shrink-0 border-t border-ds-line/30 bg-ds-elevated/60 px-4 pt-4 pb-3 shadow-ds-drawer-foot md:px-6">
              {footer}
            </footer>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
