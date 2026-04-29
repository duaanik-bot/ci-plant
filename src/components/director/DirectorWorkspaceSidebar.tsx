'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Box, Cog, FileText, PanelLeftClose, PanelRight, Pin } from 'lucide-react'
import type { PaletteRecentStored } from '@/lib/command-palette-types'
import { loadPaletteRecent } from '@/lib/command-palette-recent'
import {
  loadWorkspaceCollapsed,
  loadWorkspacePins,
  saveWorkspaceCollapsed,
  toggleWorkspacePin,
} from '@/lib/director-workspace-storage'
import { resolvePaletteEntryToLineId, type DirectorLineRef } from '@/lib/director-workspace-resolve'

const TRANSITION = 'transition-[width,min-width] duration-200 ease-in-out'

function formatRupee(n: number) {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

type GridRowLike = DirectorLineRef & {
  stageKeyDerived: string
  lineValue: number
  directorHold: boolean
  ageDaysSincePoReceipt: number
}

function entryKind(entry: PaletteRecentStored): 'po' | 'product' | 'die' {
  if (entry.groupId === 'orders') return 'po'
  if (entry.groupId === 'tooling') return 'die'
  return 'product'
}

function KindIcon({ kind }: { kind: 'po' | 'product' | 'die' }) {
  if (kind === 'po') return <FileText className="h-4 w-4 shrink-0 text-ds-ink-muted" aria-hidden />
  if (kind === 'die') return <Cog className="h-4 w-4 shrink-0 text-ds-ink-muted" aria-hidden />
  return <Box className="h-4 w-4 shrink-0 text-ds-ink-muted" aria-hidden />
}

type StatusDot = 'green' | 'amber' | 'red'

function dotFromRow(r: GridRowLike): StatusDot {
  if (r.directorHold || r.ageDaysSincePoReceipt > 7) return 'red'
  const s = r.stageKeyDerived.toLowerCase()
  if (s === 'artwork' || s === 'tooling' || s === 'material') return 'amber'
  return 'green'
}

function dotFromStored(entry: PaletteRecentStored): StatusDot {
  const t = entry.statusBadge?.text?.toLowerCase() ?? ''
  const sub = `${entry.subtitle ?? ''} ${t}`.toLowerCase()
  if (sub.includes('poor') || sub.includes('inactive')) return 'red'
  if (t.includes('pending') || t.includes('draft')) return 'amber'
  if (t.includes('confirmed') || sub.includes('good')) return 'green'
  return 'amber'
}

function StatusDotEl({ tone }: { tone: StatusDot }) {
  const cls =
    tone === 'green'
      ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.45)]'
      : tone === 'red'
        ? 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.45)]'
        : 'bg-ds-warning shadow-[0_0_6px_rgba(245,158,11,0.45)]'
  return <span className={`h-2 w-2 shrink-0 rounded-full ${cls}`} aria-hidden />
}

function tooltipLines(entry: PaletteRecentStored, row: GridRowLike | null): string {
  if (row) {
    return `PO value: ${formatRupee(row.lineValue)} · Stage: ${row.stageKeyDerived}${
      row.directorHold ? ' · ON HOLD' : ''
    }`
  }
  if (entry.groupId === 'tooling') {
    const cond =
      entry.subtitle?.split('·')[0]?.trim() ||
      entry.statusBadge?.text ||
      'Condition unknown'
    return `Die condition: ${cond}`
  }
  if (entry.groupId === 'orders') {
    return `PO: ${entry.title} · ${entry.subtitle ?? entry.statusBadge?.text ?? 'Status —'}`
  }
  return [entry.title, entry.subtitle].filter(Boolean).join(' · ') || entry.href
}

export function DirectorWorkspaceSidebar({
  rows,
  focusedLineId,
  onFocusLine,
  monoClass,
}: {
  rows: GridRowLike[]
  focusedLineId: string | null
  onFocusLine: (id: string | null) => void
  monoClass: string
}) {
  const router = useRouter()
  const [recent, setRecent] = useState<PaletteRecentStored[]>([])
  const [pins, setPins] = useState<PaletteRecentStored[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  const refresh = useCallback(() => {
    setRecent(loadPaletteRecent())
    setPins(loadWorkspacePins())
  }, [])

  useEffect(() => {
    refresh()
    setCollapsed(loadWorkspaceCollapsed())
    setHydrated(true)
  }, [refresh])

  useEffect(() => {
    const onExt = () => refresh()
    window.addEventListener('ci-palette-recent-updated', onExt)
    window.addEventListener('ci-director-workspace-updated', onExt)
    window.addEventListener('storage', onExt)
    return () => {
      window.removeEventListener('ci-palette-recent-updated', onExt)
      window.removeEventListener('ci-director-workspace-updated', onExt)
      window.removeEventListener('storage', onExt)
    }
  }, [refresh])

  const pinSet = useMemo(() => new Set(pins.map((p) => p.href)), [pins])

  const recentFiltered = useMemo(
    () => recent.filter((r) => !pinSet.has(r.href)),
    [recent, pinSet],
  )

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  const resolveRow = useCallback(
    (entry: PaletteRecentStored) => {
      const id = resolvePaletteEntryToLineId(entry, rows)
      return id ? rowById.get(id) ?? null : null
    },
    [rows, rowById],
  )

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    saveWorkspaceCollapsed(next)
  }

  const onItemActivate = (entry: PaletteRecentStored) => {
    const lineId = resolvePaletteEntryToLineId(entry, rows)
    if (lineId) {
      onFocusLine(lineId)
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-director-line="${lineId}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    } else {
      router.push(entry.href)
    }
  }

  const isPinned = (e: PaletteRecentStored) =>
    pins.some((p) => p.href === e.href || p.resultId === e.resultId)

  const renderItem = (entry: PaletteRecentStored, section: 'fav' | 'recent') => {
    const kind = entryKind(entry)
    const row = resolveRow(entry)
    const dotTone = row ? dotFromRow(row) : dotFromStored(entry)
    const tip = tooltipLines(entry, row)
    const lineId = row?.id ?? null
    const active = Boolean(lineId && focusedLineId === lineId)
    const pinnedAccent = section === 'fav'

    return (
      <div
        key={`${section}-${entry.href}`}
        className={`group relative ${TRANSITION}`}
      >
        <div
          className={`flex items-center gap-1 rounded-md border-l-2 pl-1.5 ${
            pinnedAccent ? 'border-[#f97316]' : 'border-transparent'
          }`}
        >
          {!collapsed ? (
            <button
              type="button"
              title={isPinned(entry) ? 'Unpin' : 'Pin to favorites'}
              onClick={(e) => {
                e.stopPropagation()
                toggleWorkspacePin(entry)
                refresh()
              }}
              className={`shrink-0 rounded p-1 transition-opacity hover:bg-ds-elevated/80 ${
                isPinned(entry) ? 'text-[#f97316]' : 'text-ds-ink-faint opacity-60 hover:opacity-100'
              }`}
              aria-label={isPinned(entry) ? 'Unpin' : 'Pin'}
            >
              <Pin className={`h-3.5 w-3.5 ${isPinned(entry) ? 'fill-[#f97316]' : ''}`} />
            </button>
          ) : null}
          <button
            type="button"
            title={collapsed ? tip : undefined}
            onClick={() => onItemActivate(entry)}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-200 ease-in-out hover:bg-ds-elevated/60 ${
              active ? 'bg-[#f97316]/10 ring-1 ring-[#f97316]/40' : ''
            }`}
          >
            <KindIcon kind={kind} />
            {!collapsed ? (
              <>
                <span className={`min-w-0 flex-1 truncate text-xs font-medium text-ds-ink ${monoClass}`}>
                  {entry.title}
                </span>
                <StatusDotEl tone={dotTone} />
              </>
            ) : (
              <StatusDotEl tone={dotTone} />
            )}
          </button>
        </div>
        {!collapsed ? (
          <div
            className="pointer-events-none absolute left-full top-1/2 z-[60] ml-2 w-max max-w-[240px] -translate-y-1/2 rounded border border-ds-line/50 bg-ds-main/95 px-2 py-1.5 text-xs leading-snug text-ds-ink opacity-0 shadow-xl backdrop-blur-md ring-1 ring-ring/20 transition-opacity duration-150 group-hover:opacity-100"
            role="tooltip"
          >
            {tip}
          </div>
        ) : null}
      </div>
    )
  }

  if (!hydrated) {
    return (
      <aside
        className={`hidden shrink-0 border-r border-ds-line/40 bg-ds-main/50 backdrop-blur-xl md:block ${TRANSITION}`}
        style={{ width: 52, minWidth: 52 }}
        aria-hidden
      />
    )
  }

  const w = collapsed ? 52 : 260

  return (
    <aside
      className={`hidden shrink-0 border-r border-ds-line/40 bg-ds-main/50 backdrop-blur-xl md:flex md:flex-col ${TRANSITION}`}
      style={{ width: w, minWidth: w }}
      aria-label="Workspace quick access"
    >
      <div className="flex items-center justify-between gap-1 border-b border-ds-line/50 px-2 py-2">
        {!collapsed ? (
          <span className="text-xs font-bold uppercase tracking-[0.18em] text-ds-ink-faint">
            Workspace
          </span>
        ) : (
          <span className="sr-only">Workspace</span>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          className="rounded-md p-1.5 text-ds-ink-faint transition-colors hover:bg-ds-elevated/80 hover:text-[#f97316]"
          title={collapsed ? 'Expand workspace' : 'Collapse workspace'}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <PanelRight className="h-4 w-4" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {pins.length > 0 ? (
          <div className="mb-3">
            {!collapsed ? (
              <div className="mb-1.5 px-1 text-xs font-bold uppercase tracking-wider text-[#f97316]/90">
                Favorites
              </div>
            ) : null}
            <div className="space-y-0.5">{pins.map((p) => renderItem(p, 'fav'))}</div>
          </div>
        ) : null}

        {recentFiltered.length > 0 ? (
          <div>
            {!collapsed ? (
              <div className="mb-1.5 px-1 text-xs font-bold uppercase tracking-wider text-ds-ink-faint">
                Recent
              </div>
            ) : null}
            <div className="space-y-0.5">
              {recentFiltered.map((r) => renderItem(r, 'recent'))}
            </div>
          </div>
        ) : null}

        {pins.length === 0 && recentFiltered.length === 0 && !collapsed ? (
          <p className={`px-1 py-4 text-center text-xs leading-relaxed text-ds-ink-faint ${monoClass}`}>
            Use global search (⌘K). Items appear here automatically.
          </p>
        ) : null}
      </div>

      <div className="border-t border-ds-line/50 px-2 py-1.5">
        <p className={`text-xs text-ds-ink-faint ${monoClass}`}>
          <span className="text-[#f97316]/90">Anik Dua</span>
          {!collapsed ? <span> · quick access</span> : null}
        </p>
      </div>
    </aside>
  )
}
