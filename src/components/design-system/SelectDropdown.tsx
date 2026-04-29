'use client'

import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export type SelectDropdownProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string
  error?: string
}

/** Native select with DS shell — use Combobox where search is required. */
export const SelectDropdown = forwardRef<HTMLSelectElement, SelectDropdownProps>(function SelectDropdown(
  { className, label, error, id, children, ...props },
  ref,
) {
  const sid = id ?? props.name
  return (
    <div className="space-y-1.5">
      {label ? (
        <label htmlFor={sid} className="block text-xs font-medium text-ds-ink-muted">
          {label}
        </label>
      ) : null}
      <select
        ref={ref}
        id={sid}
        className={cn('ds-input cursor-pointer pr-3', error && 'border-ds-error/60', className)}
        aria-invalid={error ? true : undefined}
        {...props}
      >
        {children}
      </select>
      {error ? <p className="text-xs text-ds-error">{error}</p> : null}
    </div>
  )
})
