'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { CornerDownLeft, History, Package, Search } from 'lucide-react'
import type {
  CommandPaletteGroup,
  CommandPaletteResult,
  PaletteRecentStored,
} from '@/lib/command-palette-types'
import {
  loadPaletteRecent,
  paletteCategoryToRecentGroupId,
  rememberPaletteNavigation,
  storedToCommandResult,
} from '@/lib/command-palette-recent'
import { pastingStyleSearchBadgeClass, pastingStyleShortLabel } from '@/lib/pasting-style'
import clsx from 'clsx'

const DEBOUNCE_MS = 200

type FlatRow = {
  group: CommandPaletteGroup
  result: CommandPaletteResult
  flatIndex: number
}

type CommandPaletteContextValue = {
  open: () => void
  /** Live text from the palette search field (persists after close — use to filter in-page lists). */
  paletteQuery: string
  clearPaletteQuery: () => void
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null)

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext)
  if (!ctx) {
    throw new Error('useCommandPalette must be used within CommandPaletteProvider')
  }
  return ctx
}

function CommandPaletteModal({
  open,
  onOpenChange,
  query,
  onQueryChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  query: string
  onQueryChange: (v: string) => void
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(false)
  const [groups, setGroups] = useState<CommandPaletteGroup[]>([])
  const [recentItems, setRecentItems] = useState<PaletteRecentStored[]>([])
  const [selectedFlat, setSelectedFlat] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) {
      setGroups([])
      setSelectedFlat(0)
    } else {
      setRecentItems(loadPaletteRecent())
    }
  }, [open])

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (!open) return
    const run = async () => {
      if (debounced.length < 2) {
        setGroups([])
        setLoading(false)
        return
      }
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setLoading(true)
      try {
        const res = await fetch(
          `/api/search/command-palette?q=${encodeURIComponent(debounced)}`,
          { signal: ac.signal },
        )
        const json = (await res.json()) as { groups?: CommandPaletteGroup[] }
        if (!ac.signal.aborted) {
          setGroups(Array.isArray(json.groups) ? json.groups : [])
          setSelectedFlat(0)
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setGroups([])
        }
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    }
    void run()
    return () => abortRef.current?.abort()
  }, [debounced, open])

  const debouncePending = query.trim().length >= 2 && debounced !== query.trim()

  const displayGroups = useMemo((): CommandPaletteGroup[] => {
    if (query.trim().length === 0) {
      const results = recentItems.map(storedToCommandResult)
      if (results.length === 0) return []
      return [{ id: 'recent', label: 'RECENT ACTIVITY', results }]
    }
    if (debounced.length < 2) return []
    return groups
  }, [query, debounced, recentItems, groups])

  const flatRows = useMemo(() => {
    const rows: FlatRow[] = []
    let flatIndex = 0
    for (const group of displayGroups) {
      for (const result of group.results) {
        rows.push({ group, result, flatIndex: flatIndex++ })
      }
    }
    return rows
  }, [displayGroups])

  useEffect(() => {
    if (!open) return
    setSelectedFlat(0)
  }, [open, query, debounced])

  useEffect(() => {
    if (!open) return
    const id = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (selectedFlat >= flatRows.length) {
      setSelectedFlat(flatRows.length > 0 ? flatRows.length - 1 : 0)
    }
  }, [flatRows.length, selectedFlat])

  const persistRecentForResult = useCallback((r: CommandPaletteResult, category: string) => {
    if (r.recentSource) {
      rememberPaletteNavigation(r.recentSource)
      return
    }
    const gid = paletteCategoryToRecentGroupId(category)
    if (!gid) return
    rememberPaletteNavigation({
      href: r.href,
      title: r.title,
      subtitle: r.subtitle,
      resultId: r.id,
      groupId: gid,
      titleMono: r.titleMono,
      subtitleMono: r.subtitleMono,
      showMasterIcon: r.showMasterIcon,
      statusBadge: r.statusBadge,
    })
  }, [])

  const navigateTo = useCallback(
    async (r: CommandPaletteResult, category: string) => {
      persistRecentForResult(r, category)
      onOpenChange(false)
      try {
        void fetch('/api/search/command-palette/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ href: r.href, title: r.title, category }),
        })
      } catch {
        /* audit is best-effort */
      }
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      router.push(r.href)
    },
    [onOpenChange, persistRecentForResult, queryClient, router],
  )

  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [open, onOpenChange])

  const onPaletteKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedFlat((i) => Math.min(i + 1, Math.max(0, flatRows.length - 1)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedFlat((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' && flatRows.length > 0) {
        e.preventDefault()
        const row = flatRows[selectedFlat]
        if (row) void navigateTo(row.result, row.group.label)
      }
    },
    [flatRows, navigateTo, selectedFlat],
  )

  useEffect(() => {
    if (!open || flatRows.length === 0) return
    const el = panelRef.current?.querySelector<HTMLElement>(`[data-flat-index="${selectedFlat}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, flatRows.length, selectedFlat])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex justify-center bg-background/80 px-3 pt-[10vh] backdrop-blur-md sm:pt-[12vh]"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false)
      }}
    >
      <div
        ref={panelRef}
        className="flex h-[min(70vh,560px)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl ring-1 ring-ring/20 backdrop-blur-xl"
        onKeyDown={onPaletteKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-ds-warning" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="PO #, customer, carton, die, artwork code…"
            className="min-w-0 flex-1 bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            aria-controls="command-palette-results"
          />
          {loading || debouncePending ? (
            <span className="text-xs text-ds-ink-faint tabular-nums">Searching…</span>
          ) : (
            <span className="flex items-center gap-0.5 text-xs text-ds-ink-faint">
              <CornerDownLeft className="h-3 w-3" aria-hidden />
              go
            </span>
          )}
        </div>
        <div
          id="command-palette-results"
          className="flex-1 overflow-y-auto px-1 py-2 text-sm"
          role="listbox"
          aria-label="Search results"
        >
          {query.trim().length > 0 && debounced.length < 2 && !debouncePending ? (
            <p className="px-3 py-6 text-center text-xs text-ds-ink-faint">Type at least 2 characters.</p>
          ) : null}
          {debounced.length >= 2 &&
          !loading &&
          !debouncePending &&
          flatRows.length === 0 &&
          query.trim().length > 0 ? (
            <p className="px-3 py-8 text-center text-xs leading-relaxed text-ds-ink-faint">
              No records found. Searching for a PO, Die ID, or Product Name?
            </p>
          ) : null}
          {displayGroups.map((g) => (
            <div key={g.id} className="mb-3">
              <div className="sticky top-0 z-10 bg-card px-2 py-1 text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
                [ {g.label} ]
              </div>
              <ul className="space-y-0.5">
                {g.results.map((r) => {
                  const row = flatRows.find((x) => x.result.id === r.id)
                  const flatIndex = row?.flatIndex ?? -1
                  const active = flatIndex === selectedFlat
                  return (
                    <li key={r.id} role="option" aria-selected={active}>
                      <button
                        type="button"
                        data-flat-index={flatIndex}
                        onClick={() => void navigateTo(r, g.label)}
                        onMouseEnter={() => setSelectedFlat(flatIndex)}
                        className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition ${
                          active
                            ? 'border-l-2 border-l-[#f97316] bg-[#f97316]/[0.07] text-ds-ink shadow-[inset_0_0_24px_rgba(249,115,22,0.06)]'
                            : 'border-l-2 border-l-transparent text-ds-ink hover:bg-ds-elevated/40'
                        }`}
                      >
                        {r.isRecent ? (
                          <History
                            className="mt-0.5 h-4 w-4 shrink-0 text-ds-warning/80"
                            aria-hidden
                          />
                        ) : r.showMasterIcon ? (
                          <Package
                            className="mt-0.5 h-4 w-4 shrink-0 text-ds-ink-faint opacity-80"
                            aria-hidden
                          />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={`truncate font-medium ${r.titleMono ? 'font-designing-queue text-sm tabular-nums tracking-tight' : ''}`}
                            >
                              {r.title}
                            </span>
                            {r.statusBadge ? (
                              <span
                                className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${r.statusBadge.className}`}
                              >
                                {r.statusBadge.text}
                              </span>
                            ) : null}
                            {r.pastingStyle ? (
                              <span className={pastingStyleSearchBadgeClass(r.pastingStyle)}>
                                {pastingStyleShortLabel(r.pastingStyle)}
                              </span>
                            ) : null}
                          </div>
                          {r.subtitle ? (
                            <div
                              className={`truncate text-xs text-ds-ink-faint ${r.subtitleMono ? 'font-designing-queue tabular-nums tracking-tight' : ''}`}
                            >
                              {r.subtitle}
                            </div>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span className="text-ds-ink-faint">Navigator: </span>
          <span className="text-[#f97316]/90">Anik Dua</span>
          <span className="text-ds-ink-faint"> · audits navigation</span>
        </div>
      </div>
    </div>
  )
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const pathname = usePathname()
  const hotkeyDisabled =
    pathname === '/orders/planning' ||
    pathname === '/orders/designing'
  const value = useMemo(
    () => ({
      open: () => setOpen(true),
      paletteQuery,
      clearPaletteQuery: () => setPaletteQuery(''),
    }),
    [paletteQuery],
  )

  useEffect(() => {
    if (hotkeyDisabled) return
    const onKey = (e: KeyboardEvent) => {
      const isK = e.key === 'k' || e.key === 'K'
      if ((e.metaKey || e.ctrlKey) && isK) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkeyDisabled])

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPaletteModal
        open={open}
        onOpenChange={setOpen}
        query={paletteQuery}
        onQueryChange={setPaletteQuery}
      />
    </CommandPaletteContext.Provider>
  )
}

export function CommandPaletteTrigger({
  className,
  placeholder,
  variant = 'default',
}: {
  className?: string
  placeholder?: string
  variant?: 'default' | 'navbar'
} = {}) {
  const { open } = useCommandPalette()
  const [kbdHint, setKbdHint] = useState('⌘K')
  useEffect(() => {
    const mac = /Mac|iPod|iPhone|iPad/i.test(
      typeof navigator !== 'undefined' ? navigator.userAgent : '',
    )
    setKbdHint(mac ? '⌘K' : 'Ctrl+K')
  }, [])
  const resolvedPlaceholder =
    placeholder ??
    (variant === 'navbar'
      ? 'Search anything…'
      : 'Search POs, dies, products, jobs…')
  return (
    <button
      type="button"
      onClick={() => open()}
      className={clsx(
        'flex w-full items-center gap-2 text-left text-sm transition duration-200',
        variant === 'navbar'
          ? clsx(
              'max-w-none rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-4 py-2.5 text-[var(--text-secondary)] shadow-[0_2px_14px_rgba(15,23,42,0.06),0_0_0_1px_rgba(249,115,22,0.07)] hover:border-[rgba(249,115,22,0.45)] hover:shadow-[0_6px_28px_rgba(15,23,42,0.1),0_0_24px_rgba(249,115,22,0.12)] dark:shadow-[0_2px_20px_rgba(0,0,0,0.35)]',
            )
          : clsx(
              'max-w-xl rounded-lg border border-border bg-card/70 px-3 py-2 text-muted-foreground shadow-inner ring-1 ring-ring/20 backdrop-blur-md hover:border-primary/40 hover:bg-accent hover:text-accent-foreground',
            ),
        className,
      )}
      aria-label="Open command palette"
    >
      <Search
        className={clsx(
          'h-4 w-4 shrink-0',
          variant === 'navbar' ? 'text-[var(--text-secondary)]' : 'text-ds-ink-faint',
        )}
        aria-hidden
      />
      <span className="flex-1 truncate">{resolvedPlaceholder}</span>
      <kbd
        className={clsx(
          'hidden rounded px-1.5 py-0.5 text-xs font-mono sm:inline',
          variant === 'navbar'
            ? 'border border-[var(--border)] bg-[var(--bg-main)] text-[var(--text-secondary)]'
            : 'border border-ds-line/60 bg-ds-main/80 text-ds-ink-faint',
        )}
      >
        {kbdHint}
      </kbd>
    </button>
  )
}

export function CommandPaletteTriggerIcon() {
  const { open } = useCommandPalette()
  return (
    <button
      type="button"
      onClick={() => open()}
      className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-primary"
      aria-label="Open command palette"
    >
      <Search className="h-5 w-5" />
    </button>
  )
}
