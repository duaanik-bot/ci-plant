import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type SummaryBlockProps = {
  label: string
  value: ReactNode
  /** Large green total (costing) */
  emphasize?: 'total' | 'default'
  className?: string
}

export function SummaryBlock({ label, value, emphasize = 'default', className }: SummaryBlockProps) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 border-t border-ds-line/60 pt-3 first:border-t-0 first:pt-0',
        className,
      )}
    >
      <span
        className={cn('text-xs text-ds-ink-faint', emphasize === 'total' && 'text-sm font-medium text-ds-ink-muted')}
      >
        {label}
      </span>
      <span
        className={cn(
          'tabular-nums',
          emphasize === 'total' ? 'text-2xl font-bold text-ds-success' : 'text-sm font-medium text-ds-ink',
        )}
      >
        {value}
      </span>
    </div>
  )
}
