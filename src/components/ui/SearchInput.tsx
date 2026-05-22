'use client'

import { Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * SearchInput
 * ────────────
 * A search box with leading icon and inline clear (×) button.
 *
 * Usage:
 *   const [q, setQ] = useState('')
 *   <SearchInput value={q} onChange={setQ} placeholder="Search customers…" className="w-64" />
 */
interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  className,
}: SearchInputProps) {
  return (
    <div className={cn('relative', className)}>
      <Search
        size={14}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-ds-ink-faint pointer-events-none"
      />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="
          w-full pl-9 pr-8 py-2 text-sm rounded-ds-sm border border-ds-line outline-none
          bg-ds-card text-ds-ink placeholder:text-ds-ink-faint
          focus:border-ds-brand focus:ring-2 focus:ring-ds-brand/15 transition-colors
        "
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ds-ink-faint hover:text-ds-ink transition-colors"
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

export default SearchInput
