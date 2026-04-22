'use client'

import type { ReactNode } from 'react'
import { SlideOverPanel, type StandardSlideOverOptions } from '@/components/ui/SlideOverPanel'
import { cn } from '@/lib/cn'

type DrawerProps = StandardSlideOverOptions & {
  title: ReactNode
  headerMeta?: ReactNode
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  zIndexClass?: string
}

/**
 * App drawer shell — same rail + overlay as {@link StandardDrawer}; use for custom body/footer.
 */
export function Drawer({ panelClassName, backdropClassName, ...rest }: DrawerProps) {
  return (
    <SlideOverPanel
      panelClassName={cn(panelClassName)}
      backdropClassName={cn(backdropClassName)}
      {...rest}
    />
  )
}
