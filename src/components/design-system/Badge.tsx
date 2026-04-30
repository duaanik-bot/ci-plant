import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'

const toneMap: Record<Tone, string> = {
  neutral:
    'border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text-secondary)]',
  brand:
    'border-transparent bg-[var(--brand-bg-soft)] text-[var(--brand-primary)]',
  success: 'border-transparent bg-[var(--success-bg)] text-[var(--success)]',
  warning: 'border-transparent bg-[var(--warning-bg)] text-[var(--warning)]',
  danger: 'border-transparent bg-[var(--error-bg)] text-[var(--error)]',
}

export function Badge({ className, tone = 'neutral', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-ds-sm border px-2 py-0.5 text-xs font-semibold leading-tight',
        toneMap[tone],
        className,
      )}
      {...props}
    />
  )
}
