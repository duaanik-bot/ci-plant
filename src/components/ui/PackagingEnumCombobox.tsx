'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { withLegacyOption } from '@/lib/master-enums'

type PackagingEnumComboboxProps = {
  id?: string
  /** Canonical options (from master-enums). */
  options: readonly string[]
  value: string | null | undefined
  onChange: (next: string | null) => void
  disabled?: boolean
  allowEmpty?: boolean
  emptyLabel?: string
  placeholder?: string
  className?: string
  /** Applied to the outer control wrapper (border/background). */
  controlClassName?: string
  /** Applied to the text input. */
  inputClassName?: string
  'aria-label'?: string
}

/**
 * Searchable single-select: typing filters options; only canonical values commit (no free-text save).
 * Unknown legacy DB values appear in the list until the user picks a canonical value.
 */
export function PackagingEnumCombobox({
  id: idProp,
  options: masterOptions,
  value,
  onChange,
  disabled = false,
  allowEmpty = true,
  emptyLabel = '—',
  placeholder = 'Type to search…',
  className = '',
  controlClassName = '',
  inputClassName = '',
  'aria-label': ariaLabel = 'Packaging field',
}: PackagingEnumComboboxProps) {
  const genId = useId()
  const id = idProp ?? genId
  const listId = `${id}-listbox`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const mergedOptions = useMemo(
    () => withLegacyOption(masterOptions as readonly string[], value),
    [masterOptions, value],
  )

  const displayValue = value?.trim() ?? ''

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return mergedOptions
    return mergedOptions.filter((o) => o.toLowerCase().includes(q))
  }, [mergedOptions, query])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const commit = useCallback(
    (next: string | null) => {
      const canonical =
        next && (masterOptions as readonly string[]).includes(next)
          ? next
          : next && mergedOptions.includes(next)
            ? next
            : null
      onChange(allowEmpty ? canonical : canonical ?? masterOptions[0] ?? '')
      setQuery('')
      setOpen(false)
    },
    [allowEmpty, masterOptions, mergedOptions, onChange],
  )

  const onPick = useCallback(
    (opt: string) => {
      commit(opt === '' ? null : opt)
    },
    [commit],
  )

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered.length === 1) {
        onPick(filtered[0]!)
        return
      }
      const exact = filtered.find((o) => o.toLowerCase() === query.trim().toLowerCase())
      if (exact) {
        onPick(exact)
        return
      }
      if (filtered.length > 0) onPick(filtered[0]!)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
    }
  }

  return (
    <div ref={containerRef} className={`relative min-w-0 ${className}`}>
      <div
        className={`flex items-center gap-0.5 rounded border border-[#E2E8F0] bg-card shadow-sm transition-colors ${
          disabled ? 'opacity-50 pointer-events-none' : 'hover:bg-slate-50 focus-within:ring-2 focus-within:ring-blue-500/25'
        } ${controlClassName}`}
      >
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          disabled={disabled}
          placeholder={placeholder}
          className={`min-w-0 flex-1 border-0 bg-transparent py-1.5 pl-2 pr-1 text-[13px] text-[#0F172A] outline-none placeholder:text-slate-400 ${inputClassName}`}
          value={open ? query : displayValue}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setQuery(displayValue)
            setOpen(true)
          }}
          onBlur={() => {
            window.setTimeout(() => {
              const q = query.trim()
              if (!q && allowEmpty) {
                commit(null)
                return
              }
              const exact = (masterOptions as readonly string[]).find((o) => o.toLowerCase() === q.toLowerCase())
              if (exact) {
                commit(exact)
                return
              }
              const legacy = mergedOptions.find((o) => o.toLowerCase() === q.toLowerCase())
              if (legacy) commit(legacy)
              else commit(displayValue ? displayValue : null)
              setQuery('')
            }, 120)
          }}
          onKeyDown={onInputKeyDown}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          className="shrink-0 rounded-r px-1.5 py-1.5 text-slate-500 hover:bg-slate-100"
          aria-label="Open list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setOpen((o) => !o)
            if (!open) inputRef.current?.focus()
          }}
        >
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {open && !disabled ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-0.5 max-h-48 overflow-auto rounded-md border border-[#E2E8F0] bg-card py-0.5 shadow-lg"
        >
          {allowEmpty ? (
            <li
              role="option"
              className="cursor-pointer px-2 py-1.5 text-[12px] text-slate-500 hover:bg-slate-50"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick('')}
            >
              {emptyLabel}
            </li>
          ) : null}
          {filtered.map((opt) => (
            <li
              key={opt}
              role="option"
              className={`cursor-pointer px-2 py-1.5 text-[12px] text-[#0F172A] hover:bg-slate-50 ${
                opt === displayValue ? 'bg-blue-50' : ''
              }`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(opt)}
            >
              {opt}
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="px-2 py-2 text-[11px] text-slate-500">No match — pick from master list</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
