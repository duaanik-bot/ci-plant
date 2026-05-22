'use client'

import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ButtonHTMLAttributes, ElementType } from 'react'

/**
 * Button
 * ──────
 * Variants:  primary | secondary | danger | ghost | outline
 * Sizes:     sm | md | lg
 * Props:     loading, disabled, icon (lucide component), onClick, type, className
 *
 * Usage:
 *   <Button variant="primary" icon={Plus} onClick={handleAdd}>Add Item</Button>
 *   <Button variant="danger" loading={isDeleting}>Delete</Button>
 *   <Button variant="ghost" size="sm">Cancel</Button>
 */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline'
type Size    = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary:   'bg-ds-brand text-white hover:bg-ds-brand-hover disabled:opacity-50',
  secondary: 'bg-ds-elevated text-ds-ink hover:bg-ds-elevated/80 disabled:opacity-50',
  danger:    'bg-ds-error text-white hover:opacity-90 disabled:opacity-50',
  ghost:     'text-ds-ink-muted hover:bg-ds-elevated disabled:opacity-50',
  outline:   'border border-ds-line text-ds-ink bg-ds-card hover:bg-ds-elevated disabled:opacity-50',
}

const sizes: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-5 py-2.5 text-sm gap-2',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ElementType
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon: Icon,
  className,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 12 : 14

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center font-medium rounded-ds-sm transition-colors cursor-pointer',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading
        ? <Loader2 size={iconSize} className="animate-spin shrink-0" />
        : Icon && <Icon size={iconSize} className="shrink-0" />
      }
      {children}
    </button>
  )
}

export default Button
