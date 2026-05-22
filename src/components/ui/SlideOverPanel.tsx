'use client'

import type { ReactNode } from 'react'
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
 * Shared-drawer adapter. Previously a right-rail slide-over; now renders the application-standard
 * centered GlobalPopoutModal. Prop signature is preserved so StandardDrawer / Drawer /
 * IndustrialSheet consumers are unchanged. `widthClass` maps to the modal's explicit width;
 * `backdropClassName` / `animateEnter` / `zIndexClass` are accepted for back-compat and ignored
 * (the modal owns backdrop, animation, and z-index).
 */
export function SlideOverPanel({
  title,
  headerMeta,
  isOpen,
  onClose,
  children,
  footer,
  widthClass,
  panelClassName,
}: SlideOverPanelProps) {
  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      metadata={headerMeta}
      footer={footer}
      size="xl"
      widthClass={widthClass}
      panelClassName={panelClassName}
    >
      {children}
    </GlobalPopoutModal>
  )
}
