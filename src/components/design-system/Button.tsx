'use client'

import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success' | 'utility'

const variantClass: Record<Variant, string> = {
  primary:
    'bg-[var(--brand-primary)] text-white shadow-sm hover:bg-[var(--brand-primary-hover)] hover:brightness-[1.02] hover:shadow-md focus-visible:ring-[var(--brand-primary)]/40',
  secondary:
    'border border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text-primary)] shadow-sm hover:bg-[var(--bg-card)] hover:shadow-md focus-visible:ring-[var(--brand-primary)]/25',
  danger:
    'bg-[var(--error)] text-white hover:opacity-95 focus-visible:ring-[var(--error)]/35',
  ghost:
    'text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] focus-visible:ring-[var(--brand-primary)]/20',
  success:
    'bg-[var(--success)] text-white shadow-sm hover:brightness-95 hover:shadow-md focus-visible:ring-[var(--success)]/35',
  utility:
    'border border-violet-400/45 bg-violet-500/10 text-violet-700 shadow-sm hover:bg-violet-500/15 hover:shadow-md focus-visible:ring-violet-400/35 dark:text-violet-300',
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-ds-sm px-4 py-2 text-sm font-medium transition-[box-shadow,background-color,border-color,filter] duration-200 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-45',
        variantClass[variant],
        className,
      )}
      {...props}
    />
  )
})
