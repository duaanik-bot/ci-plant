'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

type SearchSelectItem = {
  id: string
}

type MasterSearchSelectProps<T extends SearchSelectItem> = {
  label: string
  required?: boolean
  hideLabel?: boolean
  placeholder?: string
  query: string
  onQueryChange: (value: string) => void
  loading: boolean
  options: T[]
  lastUsed: T[]
  onSelect: (item: T) => void
  getOptionLabel: (item: T) => string
  getOptionMeta?: (item: T) => string | null | undefined
  error?: string
  disabled?: boolean
  emptyMessage?: string
  recentLabel?: string
  loadingMessage?: string
  emptyActionLabel?: string
  onEmptyAction?: () => void
  /** Full list to show while query is empty (e.g. all cartons for selected customer). Recent items are listed first and omitted from this list in the UI. */
  browseOptions?: T[]
  browseOptionsLabel?: string
  browseLoading?: boolean
  browseLoadingMessage?: string
  /** Shown when query is empty, browse finished, and there are no products + no recent items. */
  browseEmptyMessage?: string | null
  containerClassName?: string
  inputClassName?: string
  dropdownClassName?: string
  /** Sticky area under the option list, e.g. “+ New …” that keeps the user on the current screen. */
  dropdownFooter?: ReactNode
}

export function MasterSearchSelect<T extends SearchSelectItem>({
  label,
  required = false,
  hideLabel = false,
  placeholder,
  query,
  onQueryChange,
  loading,
  options,
  lastUsed,
  onSelect,
  getOptionLabel,
  getOptionMeta,
  error,
  disabled = false,
  emptyMessage = 'No matching records found.',
  recentLabel = 'Recent selections',
  loadingMessage = 'Searching...',
  emptyActionLabel,
  onEmptyAction,
  browseOptions,
  browseOptionsLabel = 'Products for this customer',
  browseLoading = false,
  browseLoadingMessage = 'Loading products…',
  browseEmptyMessage = null,
  containerClassName,
  inputClassName,
  dropdownClassName,
  dropdownFooter,
}: MasterSearchSelectProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  useEffect(() => {
    function handleOutside(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [])

  const trimmedQuery = query.trim()
  const recentIds = useMemo(() => new Set(lastUsed.map((x) => x.id)), [lastUsed])
  const browseDeduped = useMemo(
    () => (browseOptions ?? []).filter((b) => !recentIds.has(b.id)),
    [browseOptions, recentIds],
  )

  const visibleItems = useMemo(() => {
    if (trimmedQuery.length > 0) return options
    return [...lastUsed, ...browseDeduped]
  }, [trimmedQuery, options, lastUsed, browseDeduped])

  const showEmpty = trimmedQuery.length > 0 && !loading && !browseLoading && options.length === 0

  const showIdlePanel =
    open &&
    !disabled &&
    trimmedQuery.length === 0 &&
    (browseLoading ||
      lastUsed.length > 0 ||
      browseDeduped.length > 0 ||
      (!!browseEmptyMessage && !browseLoading))

  const showSearchPanel = open && !disabled && trimmedQuery.length > 0 && (loading || options.length > 0 || showEmpty)

  const showDropdown = showIdlePanel || showSearchPanel || (open && !disabled && loading && trimmedQuery.length > 0)

  useEffect(() => {
    setActiveIndex(visibleItems.length > 0 ? 0 : -1)
  }, [visibleItems.length, showDropdown, trimmedQuery])

  const commitSelection = (item: T) => {
    onSelect(item)
    setOpen(false)
  }

  const setActiveById = (id: string) => {
    const i = visibleItems.findIndex((x) => x.id === id)
    if (i >= 0) setActiveIndex(i)
  }

  return (
    <div ref={containerRef} className={`relative ${containerClassName ?? ''}`}>
      {!hideLabel ? (
        <label className="block text-xs text-slate-400 mb-1">
          {label}
          {required ? <span className="text-red-400">*</span> : null}
        </label>
      ) : null}
      <input
        type="text"
        value={query}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!showDropdown && (e.key === 'ArrowDown' || e.key === 'Enter')) {
            setOpen(true)
            return
          }
          if (e.key === 'Escape') {
            setOpen(false)
            return
          }
          if (!visibleItems.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActiveIndex((prev) => (prev + 1) % visibleItems.length)
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActiveIndex((prev) => (prev <= 0 ? visibleItems.length - 1 : prev - 1))
          }
          if (e.key === 'Enter' && activeIndex >= 0 && visibleItems[activeIndex]) {
            e.preventDefault()
            commitSelection(visibleItems[activeIndex])
          }
        }}
        onChange={(e) => {
          onQueryChange(e.target.value)
          setOpen(true)
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className={`w-full px-3 py-2 rounded bg-slate-800 border ${
          error ? 'border-red-500' : 'border-slate-600'
        } text-foreground disabled:opacity-60 disabled:cursor-not-allowed ${inputClassName ?? ''}`}
      />
      {error ? <p className="text-xs text-red-400 mt-1">{error}</p> : null}

      {showDropdown ? (
        <div className={`absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl ${dropdownClassName ?? ''}`}>
          {showIdlePanel ? (
            <div className="max-h-64 overflow-y-auto py-1">
              {browseLoading ? (
                <div className="px-3 py-2 text-xs text-slate-400">{browseLoadingMessage}</div>
              ) : null}
              {!browseLoading &&
              browseEmptyMessage &&
              lastUsed.length === 0 &&
              browseDeduped.length === 0 ? (
                <div className="px-3 py-2 text-xs text-slate-500">{browseEmptyMessage}</div>
              ) : null}

              {lastUsed.length > 0 ? (
                <>
                  <div className="border-b border-slate-800 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500">
                    {recentLabel}
                  </div>
                  {lastUsed.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveById(item.id)}
                      onClick={() => commitSelection(item)}
                      className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm text-slate-100 hover:bg-slate-800 ${
                        visibleItems[activeIndex]?.id === item.id ? 'bg-slate-800' : ''
                      }`}
                    >
                      <span>{getOptionLabel(item)}</span>
                      <span className="text-[11px] text-slate-500">Recent</span>
                    </button>
                  ))}
                </>
              ) : null}

              {browseDeduped.length > 0 ? (
                <>
                  <div
                    className={`px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500 ${
                      lastUsed.length > 0 ? 'border-t border-slate-800' : 'border-b border-slate-800'
                    }`}
                  >
                    {browseOptionsLabel}
                  </div>
                  {browseDeduped.map((item) => {
                    const meta = getOptionMeta?.(item)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActiveById(item.id)}
                        onClick={() => commitSelection(item)}
                        className={`w-full px-3 py-2 text-left hover:bg-slate-800 ${
                          visibleItems[activeIndex]?.id === item.id ? 'bg-slate-800' : ''
                        }`}
                      >
                        <div className="text-sm text-slate-100">{getOptionLabel(item)}</div>
                        {meta ? <div className="text-xs text-slate-500">{meta}</div> : null}
                      </button>
                    )
                  })}
                </>
              ) : null}
            </div>
          ) : null}

          {showSearchPanel ? (
            <div className="max-h-64 overflow-y-auto py-1">
              {loading ? (
                <div className="px-3 py-2 text-xs text-slate-400">{loadingMessage}</div>
              ) : null}
              {!loading &&
                options.map((item) => {
                  const meta = getOptionMeta?.(item)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveById(item.id)}
                      onClick={() => commitSelection(item)}
                      className={`w-full px-3 py-2 text-left hover:bg-slate-800 ${
                        visibleItems[activeIndex]?.id === item.id ? 'bg-slate-800' : ''
                      }`}
                    >
                      <div className="text-sm text-slate-100">{getOptionLabel(item)}</div>
                      {meta ? <div className="text-xs text-slate-500">{meta}</div> : null}
                    </button>
                  )
                })}
              {showEmpty ? (
                <div className="px-3 py-2">
                  <div className="text-xs text-slate-500">{emptyMessage}</div>
                  {emptyActionLabel && onEmptyAction ? (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onEmptyAction()
                        setOpen(false)
                      }}
                      className="mt-2 text-xs font-medium text-amber-400 hover:text-amber-300"
                    >
                      {emptyActionLabel}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {dropdownFooter ? (
            <div
              className="border-t border-slate-800"
              onMouseDown={(e) => e.preventDefault()}
            >
              {dropdownFooter}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
