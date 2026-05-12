import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'tooling'

const toneMap: Record<Tone, string> = {
  neutral:
    'border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text-secondary)]',
  brand:
    'border-transparent bg-[var(--brand-bg-soft)] text-[var(--brand-primary)]',
  success: 'border-transparent bg-[var(--success-bg)] text-[var(--success)]',
  warning: 'border-transparent bg-[var(--warning-bg)] text-[var(--warning)]',
  danger: 'border-transparent bg-[var(--error-bg)] text-[var(--error)]',
  info: 'border-transparent bg-[var(--info-bg)] text-[var(--info)]',
  tooling: 'border-transparent bg-[var(--tooling-bg)] text-[var(--tooling)]',
}

export function Badge({ className, tone = 'neutral', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase leading-none tracking-wide',
        toneMap[tone],
        className,
      )}
      {...props}
    />
  )
}
