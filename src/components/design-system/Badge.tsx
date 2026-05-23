import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'tooling'

const toneMap: Record<Tone, string> = {
  neutral: 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]',
  brand:   'bg-[var(--brand-bg-soft)] text-[var(--brand-primary)]',
  success: 'bg-[var(--success-bg)] text-[var(--success)]',
  warning: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  danger:  'bg-[var(--error-bg)] text-[var(--error)]',
  info:    'bg-[var(--info-bg)] text-[var(--info)]',
  tooling: 'bg-[var(--tooling-bg)] text-[var(--tooling)]',
}

export function Badge({ className, tone = 'neutral', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase leading-none tracking-wide',
        toneMap[tone],
        className,
      )}
      {...props}
    />
  )
}
