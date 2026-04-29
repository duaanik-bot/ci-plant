'use client'

import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export type InputFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string
  hint?: string
  error?: string
}

export const InputField = forwardRef<HTMLInputElement, InputFieldProps>(function InputField(
  { className, label, hint, error, id, ...props },
  ref,
) {
  const lid = id ?? props.name
  return (
    <div className="space-y-1.5">
      {label ? (
        <label htmlFor={lid} className="block text-xs font-medium text-ds-ink-muted">
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={lid}
        className={cn('ds-input', error && 'border-ds-error/60 ring-1 ring-ds-error/30', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${lid}-err` : hint ? `${lid}-hint` : undefined}
        {...props}
      />
      {hint && !error ? (
        <p id={`${lid}-hint`} className="text-xs text-ds-ink-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${lid}-err`} className="text-xs text-ds-error">
          {error}
        </p>
      ) : null}
    </div>
  )
})
