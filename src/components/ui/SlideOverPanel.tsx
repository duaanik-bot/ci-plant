'use client'

import { type ReactNode } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'

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

/**
 * @deprecated Use {@link GlobalPopoutModal} directly for new code.
 *
 * Retained as a thin adapter so existing call sites keep working unchanged while
 * modules migrate. It now renders a centered pop-out modal (no longer a right-rail
 * slide-over) and forwards `mode="preview"` to preserve the historical behavior:
 * the panel closes on BOTH backdrop-click and Escape.
 *
 * The legacy presentation props `backdropClassName`, `panelClassName`, and
 * `animateEnter` are accepted for source compatibility but no longer affect
 * rendering — the modal owns its own backdrop, surface, and animation.
 */
export function SlideOverPanel({
  title,
  headerMeta,
  isOpen,
  onClose,
  children,
  footer,
  widthClass,
  zIndexClass,
}: SlideOverPanelProps) {
  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      metadata={headerMeta}
      footer={footer}
      widthClass={widthClass}
      zIndexClass={zIndexClass}
      mode="preview"
    >
      {children}
    </GlobalPopoutModal>
  )
}
