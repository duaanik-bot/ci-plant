import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type ActionBarProps = {
  children: ReactNode
  className?: string
}

/**
 * Sticky-optional row below PageHeader: filters, view toggles, primary actions.
 * Use spacing, not extra borders, for separation from the main table.
 */
export function ActionBar({ children, className }: ActionBarProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-wrap items-center justify-between gap-3 py-3 transition-opacity duration-200',
        className,
      )}
    >
      {children}
    </div>
  )
}
