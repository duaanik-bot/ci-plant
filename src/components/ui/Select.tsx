'use client'

import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { SelectHTMLAttributes } from 'react'

/**
 * Select
 * ───────
 * A styled <select> dropdown with label + error support.
 *
 * Usage:
 *   const options = [
 *     { value: '', label: '— Select status —' },
 *     { value: 'active',   label: 'Active' },
 *     { value: 'inactive', label: 'Inactive' },
 *   ]
 *   <Select label="Status" options={options} value={status} onChange={...} />
 */
interface SelectOption {
  value: string | number
  label: string
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  options?: SelectOption[]
}

export function Select({ label, error, options = [], className, ...props }: SelectProps) {
  return (
    <div className="space-y-1">
      {label && (
        <label className="block text-xs font-medium text-ds-ink-muted">{label}</label>
      )}
      <div className="relative">
        <select
          className={cn(
            'w-full px-3 py-2 pr-8 text-sm rounded-ds-sm outline-none',
            'appearance-none bg-ds-card text-ds-ink transition-colors cursor-pointer',
            error
              ? 'bg-[var(--error-bg)] focus:ring-2 focus:ring-ds-error/20'
              : 'focus:ring-2 focus:ring-ds-brand/15',
            'disabled:bg-ds-elevated disabled:text-ds-ink-faint disabled:cursor-not-allowed',
            className,
          )}
          {...props}
        >
          {options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <ChevronDown
          size={14}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ds-ink-faint pointer-events-none"
        />
      </div>
      {error && <p className="text-xs text-ds-error">{error}</p>}
    </div>
  )
}

export default Select
