'use client'

import type { ReactNode } from 'react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { cn } from '@/lib/cn'

type DrawerProps = {
  title: ReactNode
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  /** Sticky footer (primary / secondary actions). */
  footer?: ReactNode
  zIndexClass?: string
  /** Viewport width ~35–40% (capped for readability). */
  widthClass?: string
  panelClassName?: string
  backdropClassName?: string
}

/**
 * Standard right slide-over: ~35–40% width, 200ms enter (shared with SlideOverPanel).
 */
export function Drawer({
  widthClass = 'w-[min(40vw,32rem)] max-w-full',
  panelClassName,
  backdropClassName,
  ...rest
}: DrawerProps) {
  return (
    <SlideOverPanel
      widthClass={widthClass}
      backdropClassName={cn('bg-ds-main/70 backdrop-blur-[2px]', backdropClassName)}
      panelClassName={cn(
        'border-l border-ds-line bg-ds-card text-ds-ink shadow-2xl',
        'transition-shadow duration-200',
        panelClassName,
      )}
      {...rest}
    />
  )
}
