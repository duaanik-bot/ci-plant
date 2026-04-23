'use client'

import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const variantClass: Record<Variant, string> = {
  primary:
    'bg-ds-brand text-white shadow-sm hover:bg-ds-brand-hover hover:brightness-[1.04] hover:shadow-md focus-visible:ring-ds-brand/40',
  secondary:
    'border border-ds-line bg-ds-elevated/80 text-ds-ink shadow-sm hover:bg-ds-card hover:brightness-[1.02] hover:shadow-md focus-visible:ring-ds-brand/25',
  danger:
    'bg-ds-error/90 text-white hover:bg-ds-error hover:brightness-[1.04] focus-visible:ring-ds-error/35',
  ghost:
    'text-ds-ink-muted hover:bg-ds-elevated/55 focus-visible:ring-ds-brand/20',
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
