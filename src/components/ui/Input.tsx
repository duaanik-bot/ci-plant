'use client'

import { cn } from '@/lib/cn'
import type { InputHTMLAttributes } from 'react'

/**
 * Input
 * ──────
 * A labelled text input with inline error display.
 * Passes all native <input> props through via spread.
 *
 * Usage:
 *   <Input label="Email" type="email" placeholder="you@company.com" />
 *   <Input label="Amount" error="Required" value={val} onChange={...} />
 */
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export function Input({ label, error, className, ...props }: InputProps) {
  return (
    <div className="space-y-1">
      {label && (
        <label className="block text-xs font-medium text-ds-ink-muted">{label}</label>
      )}
      <input
        className={cn(
          'w-full px-3 py-2 text-sm rounded-ds-sm border outline-none transition-colors bg-ds-card text-ds-ink placeholder:text-ds-ink-faint',
          error
            ? 'border-ds-error focus:ring-2 focus:ring-ds-error/20'
            : 'border-ds-line focus:border-ds-brand focus:ring-2 focus:ring-ds-brand/15',
          'disabled:bg-ds-elevated disabled:text-ds-ink-faint disabled:cursor-not-allowed',
          className,
        )}
        {...props}
      />
      {error && <p className="text-xs text-ds-error">{error}</p>}
    </div>
  )
}

export default Input
