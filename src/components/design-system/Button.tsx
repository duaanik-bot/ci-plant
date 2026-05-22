'use client'

import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success' | 'utility'
type ExtendedVariant = Variant | 'warning' | 'info' | 'icon'

const variantClass: Record<ExtendedVariant, string> = {
  primary:
    'border border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white shadow-sm hover:bg-[var(--brand-primary-hover)] hover:shadow-md focus-visible:ring-[var(--brand-primary)]/35',
  secondary:
    'border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm hover:bg-[var(--bg-muted)] hover:shadow-md focus-visible:ring-[var(--brand-primary)]/25',
  success:
    'border border-[var(--success)]/40 bg-[var(--success-bg)] text-[var(--success)] shadow-sm hover:border-[var(--success)]/55 hover:bg-[var(--success-bg)]/90 focus-visible:ring-[var(--success)]/30',
  warning:
    'border border-[var(--warning)]/40 bg-[var(--warning-bg)] text-[var(--warning)] shadow-sm hover:border-[var(--warning)]/55 hover:bg-[var(--warning-bg)]/90 focus-visible:ring-[var(--warning)]/30',
  danger:
    'border border-[var(--error)]/45 bg-[var(--error-bg)] text-[var(--error)] shadow-sm hover:border-[var(--error)]/60 hover:bg-[var(--error-bg)]/90 focus-visible:ring-[var(--error)]/30',
  info:
    'border border-[var(--info)]/40 bg-[var(--info-bg)] text-[var(--info)] shadow-sm hover:border-[var(--info)]/55 hover:bg-[var(--info-bg)]/90 focus-visible:ring-[var(--info)]/30',
  ghost:
    'border border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] focus-visible:ring-[var(--brand-primary)]/20',
  icon:
    'h-9 w-9 rounded-ds-sm border border-[var(--border)] bg-[var(--bg-card)] px-0 py-0 text-[var(--text-secondary)] shadow-sm hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] focus-visible:ring-[var(--brand-primary)]/20',
  utility:
    'border border-[var(--tooling)]/45 bg-[var(--tooling-bg)] text-[var(--tooling)] shadow-sm hover:border-[var(--tooling)]/60 hover:bg-[var(--tooling-bg)]/90 focus-visible:ring-[var(--tooling)]/30',
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ExtendedVariant
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
        'inline-flex items-center justify-center gap-2 rounded-ds-lg px-4 py-2 text-sm font-medium transition-[box-shadow,background-color,border-color,filter] duration-200 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-[var(--bg-elevated)] disabled:text-[var(--text-muted)] disabled:shadow-none disabled:opacity-100',
        variantClass[variant],
        className,
      )}
      {...props}
    />
  )
})
