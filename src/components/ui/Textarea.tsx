'use client'

import { cn } from '@/lib/cn'
import type { TextareaHTMLAttributes } from 'react'

/**
 * Textarea
 * ─────────
 * Labelled multi-line text area with error display.
 *
 * Usage:
 *   <Textarea label="Notes" rows={4} placeholder="Internal remarks…" />
 */
interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
}

export function Textarea({ label, error, className, rows = 3, ...props }: TextareaProps) {
  return (
    <div className="space-y-1">
      {label && (
        <label className="block text-xs font-medium text-ds-ink-muted">{label}</label>
      )}
      <textarea
        rows={rows}
        className={cn(
          'w-full px-3 py-2 text-sm rounded-ds-sm outline-none resize-none transition-colors',
          'bg-ds-card text-ds-ink placeholder:text-ds-ink-faint',
          error
            ? 'bg-[var(--error-bg)] focus:ring-2 focus:ring-ds-error/20'
            : 'focus:ring-2 focus:ring-ds-brand/15',
          'disabled:bg-ds-elevated disabled:cursor-not-allowed',
          className,
        )}
        {...props}
      />
      {error && <p className="text-xs text-ds-error">{error}</p>}
    </div>
  )
}

export default Textarea
