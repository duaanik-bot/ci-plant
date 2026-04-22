import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'

const toneMap: Record<Tone, string> = {
  neutral: 'border-ds-line bg-ds-elevated/80 text-ds-ink-muted',
  brand: 'border-ds-brand/30 bg-ds-brand/15 text-ds-ink',
  success: 'border-ds-success/30 bg-ds-success/10 text-ds-success',
  warning: 'border-ds-warning/35 bg-ds-warning/10 text-ds-warning',
  danger: 'border-ds-error/30 bg-ds-error/10 text-ds-error',
}

export function Badge({ className, tone = 'neutral', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-ds-sm border px-2 py-0.5 text-[11px] font-semibold leading-tight',
        toneMap[tone],
        className,
      )}
      {...props}
    />
  )
}
