'use client'

import type { ReactNode } from 'react'
import { Button } from '@/components/design-system/Button'
import { SlideOverPanel, type StandardSlideOverOptions } from '@/components/ui/SlideOverPanel'
import { cn } from '@/lib/cn'

export type StandardDrawerAction = {
  label: string
  loadingLabel?: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
}

type StandardDrawerProps = StandardSlideOverOptions & {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  /** Secondary line under the title (e.g. PO # · status · customer) */
  metadata?: ReactNode
  children: ReactNode
  /** Optional sticky footer: primary = Save/Confirm, secondary = Cancel */
  primaryAction?: StandardDrawerAction
  secondaryAction?: StandardDrawerAction
  /** When set, replaces the built-in primary/secondary row */
  footer?: ReactNode
  bodyClassName?: string
  /** Only one drawer: stack order when needed */
  zIndexClass?: string
}

/**
 * Application-standard right rail: 38% width, clamp(420px, 38vw, 640px), subtle 25% black overlay,
 * sticky header + scroll body + optional sticky footer. Uses design tokens only.
 */
export function StandardDrawer({
  isOpen,
  onClose,
  title,
  metadata,
  children,
  primaryAction,
  secondaryAction,
  footer: footerOverride,
  bodyClassName,
  zIndexClass = 'z-[60]',
  widthClass,
  panelClassName,
  backdropClassName,
  animateEnter = true,
}: StandardDrawerProps) {
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
            {primaryAction.loading
              ? (primaryAction.loadingLabel ?? '…')
              : primaryAction.label}
          </Button>
        ) : null}
      </div>
    ) : null

  return (
    <SlideOverPanel
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      headerMeta={metadata}
      zIndexClass={zIndexClass}
      widthClass={widthClass}
      panelClassName={panelClassName}
      backdropClassName={backdropClassName}
      animateEnter={animateEnter}
      footer={footerOverride ?? builtInFooter}
    >
      <div className={cn('text-sm text-ds-ink', bodyClassName)}>{children}</div>
    </SlideOverPanel>
  )
}
