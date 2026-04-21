'use client'

import { X } from 'lucide-react'

type HubGlobalSearchBarProps = {
  value: string
  onChange: (next: string) => void
  onClear: () => void
  id?: string
  className?: string
}

const PLACEHOLDER = 'Search by Carton, AW Code, or Job ID…'

export function HubGlobalSearchBar({
  value,
  onChange,
  onClear,
  id = 'hub-global-search',
  className = '',
}: HubGlobalSearchBarProps) {
  return (
    <div className={`relative ${className}`}>
      <label htmlFor={id} className="sr-only">
        Global search
      </label>
      <input
        id={id}
        type="search"
        autoComplete="off"
        placeholder={PLACEHOLDER}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-600 bg-slate-800/90 pl-3 pr-9 py-2 text-sm text-foreground placeholder:text-slate-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
      />
      {value ? (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-700 hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  )
}
