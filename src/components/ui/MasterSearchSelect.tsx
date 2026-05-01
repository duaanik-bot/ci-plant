'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

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
  const [mounted, setMounted] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number; maxHeight: number; placeAbove: boolean } | null>(null)

  useEffect(() => setMounted(true), [])

  const menuIdRef = useRef(`mss-${Math.random().toString(36).slice(2)}`)

  const closeDropdown = () => setOpen(false)

  const recalcPosition = () => {
    const el = containerRef.current?.querySelector('input')
    if (!el) return
    const rect = el.getBoundingClientRect()
    const viewportH = window.innerHeight
    const spaceBelow = viewportH - rect.bottom
    const spaceAbove = rect.top
    const desired = 320
    const placeAbove = spaceBelow < 220 && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, Math.min(desired, placeAbove ? spaceAbove - 12 : spaceBelow - 12))
    const top = placeAbove ? Math.max(8, rect.top - maxHeight - 6) : rect.bottom + 6

    setDropdownPos({
      top,
      left: rect.left,
      width: rect.width,
      maxHeight,
      placeAbove,
    })
  }

  useEffect(() => {
    function handleOutside(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        closeDropdown()
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [])

  useEffect(() => {
    const key = `master-search-open:${menuIdRef.current}`
    const onOtherOpen = (event: Event) => {
      const custom = event as CustomEvent<{ key?: string }>
      if (custom.detail?.key !== key) closeDropdown()
    }
    window.addEventListener('master-search-open', onOtherOpen as EventListener)
    return () => window.removeEventListener('master-search-open', onOtherOpen as EventListener)
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
    if (!showDropdown) return
    recalcPosition()
    const onWin = () => recalcPosition()
    window.addEventListener('resize', onWin)
    window.addEventListener('scroll', onWin, true)
    return () => {
      window.removeEventListener('resize', onWin)
      window.removeEventListener('scroll', onWin, true)
    }
  }, [showDropdown, query, options.length, lastUsed.length, browseDeduped.length])

  useEffect(() => {
    setActiveIndex(visibleItems.length > 0 ? 0 : -1)
  }, [visibleItems.length, showDropdown, trimmedQuery])

  const commitSelection = (item: T) => {
    onSelect(item)
    closeDropdown()
  }

  const setActiveById = (id: string) => {
    const i = visibleItems.findIndex((x) => x.id === id)
    if (i >= 0) setActiveIndex(i)
  }

  return (
    <div ref={containerRef} className={`relative ${containerClassName ?? ''}`}>
      {!hideLabel ? (
        <label className="block text-xs text-ds-ink-muted mb-1">
          {label}
          {required ? <span className="text-red-400">*</span> : null}
        </label>
      ) : null}
      <input
        type="text"
        value={query}
        onFocus={() => {
          const key = `master-search-open:${menuIdRef.current}`
          window.dispatchEvent(new CustomEvent('master-search-open', { detail: { key } }))
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (!showDropdown && (e.key === 'ArrowDown' || e.key === 'Enter')) {
            setOpen(true)
            return
          }
          if (e.key === 'Escape') {
            closeDropdown()
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
          const key = `master-search-open:${menuIdRef.current}`
          window.dispatchEvent(new CustomEvent('master-search-open', { detail: { key } }))
          setOpen(true)
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className={`w-full px-3 py-2 rounded bg-ds-elevated border ${
          error ? 'border-red-500' : 'border-ds-line/60'
        } text-foreground disabled:opacity-60 disabled:cursor-not-allowed ${inputClassName ?? ''}`}
      />
      {error ? <p className="text-xs text-red-400 mt-1">{error}</p> : null}

      {showDropdown && mounted && dropdownPos
        ? createPortal(
        <div
          className={`overflow-hidden rounded-lg border border-ds-line/50 bg-ds-card shadow-2xl ${dropdownClassName ?? ''}`}
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            zIndex: 9999,
          }}
        >
          {showIdlePanel ? (
            <div className="overflow-y-auto py-1" style={{ maxHeight: dropdownPos.maxHeight }}>
              {browseLoading ? (
                <div className="px-3 py-2 text-xs text-ds-ink-muted">{browseLoadingMessage}</div>
              ) : null}
              {!browseLoading &&
              browseEmptyMessage &&
              lastUsed.length === 0 &&
              browseDeduped.length === 0 ? (
                <div className="px-3 py-2 text-xs text-ds-ink-faint">{browseEmptyMessage}</div>
              ) : null}

              {lastUsed.length > 0 ? (
                <>
                  <div className="border-b border-ds-line/40 px-3 py-2 text-xs uppercase tracking-wide text-ds-ink-faint">
                    {recentLabel}
                  </div>
                  {lastUsed.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveById(item.id)}
                      onClick={() => commitSelection(item)}
                    className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-ds-elevated ${
                      visibleItems[activeIndex]?.id === item.id ? 'bg-ds-elevated' : ''
                    }`}
                  >
                      <span className="text-sm font-semibold text-ds-ink">{getOptionLabel(item)}</span>
                      <span className="text-xs text-ds-ink-faint">Recent</span>
                    </button>
                  ))}
                </>
              ) : null}

              {browseDeduped.length > 0 ? (
                <>
                  <div
                    className={`px-3 py-2 text-xs uppercase tracking-wide text-ds-ink-faint ${
                      lastUsed.length > 0 ? 'border-t border-ds-line/40' : 'border-b border-ds-line/40'
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
                        className={`w-full px-3 py-2 text-left hover:bg-ds-elevated ${
                          visibleItems[activeIndex]?.id === item.id ? 'bg-ds-elevated' : ''
                        }`}
                      >
                        <div className="text-sm font-semibold text-ds-ink">{getOptionLabel(item)}</div>
                        {meta ? <div className="text-xs text-ds-ink-faint">{meta}</div> : null}
                      </button>
                    )
                  })}
                </>
              ) : null}
            </div>
          ) : null}

          {showSearchPanel ? (
            <div className="overflow-y-auto py-1" style={{ maxHeight: dropdownPos.maxHeight }}>
              {loading ? (
                <div className="px-3 py-2 text-xs text-ds-ink-muted">{loadingMessage}</div>
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
                      className={`w-full px-3 py-2 text-left hover:bg-ds-elevated ${
                        visibleItems[activeIndex]?.id === item.id ? 'bg-ds-elevated' : ''
                      }`}
                    >
                      <div className="text-sm font-semibold text-ds-ink">{getOptionLabel(item)}</div>
                      {meta ? <div className="text-xs text-ds-ink-faint">{meta}</div> : null}
                    </button>
                  )
                })}
              {showEmpty ? (
                <div className="px-3 py-2">
                  <div className="text-xs text-ds-ink-faint">{emptyMessage}</div>
                  {emptyActionLabel && onEmptyAction ? (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onEmptyAction()
                        setOpen(false)
                      }}
                      className="mt-2 w-full rounded border border-ds-warning/30 bg-ds-warning/10 px-2 py-1 text-left text-xs font-semibold text-ds-warning hover:bg-ds-warning/20"
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
              className="border-t border-ds-line/40"
              onMouseDown={(e) => e.preventDefault()}
            >
              {dropdownFooter}
            </div>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
