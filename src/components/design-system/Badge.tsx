import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'

const toneMap: Record<Tone, string> = {
  neutral: 'border-ds-line/50 bg-ds-elevated/60 text-ds-ink-muted',
  brand: 'border-ds-brand/25 bg-ds-brand/12 text-ds-ink',
  success: 'border-ds-success/20 bg-ds-success/8 text-ds-success',
  warning: 'border-ds-warning/25 bg-ds-warning/8 text-ds-warning',
  danger: 'border-ds-error/25 bg-ds-error/8 text-ds-error',
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
