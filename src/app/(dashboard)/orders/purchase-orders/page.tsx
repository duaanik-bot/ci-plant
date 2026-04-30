'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Search, AlertTriangle, FileDown, Pencil, Star, Trash2, X } from 'lucide-react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { CommandPaletteTriggerIcon } from '@/components/command-palette/CommandPalette'
import { PoDrawerSpotlightLines } from '@/components/orders/PoDrawerSpotlightLines'
import {
  lineItemMatchesDrawerQuery,
  purchaseOrdersMatchingDeepQuery,
} from '@/lib/po-list-deep-filter'
import { broadcastIndustrialPriorityChange } from '@/lib/industrial-priority-sync'
import {
  INDUSTRIAL_PRIORITY_ROW_CLASS,
  INDUSTRIAL_PRIORITY_STAR_ICON_CLASS,
} from '@/lib/industrial-priority-ui'
import {
  ACTION_PILL_BASE,
  ICON_BUTTON_BASE,
  ICON_BUTTON_TIGHT,
  PUSHED_CHIP_CLASS,
  STATUS_CHIP_BASE,
} from '@/components/design-system/tokens'
import { formatShortTimeAgo } from '@/lib/time-ago'
import { EnterpriseTableShell } from '@/components/ui/EnterpriseTableShell'
import { BulkActionBar, LaneCounterChips } from '@/components/design-system'
import { useUiDensity } from '@/lib/ui-density'

type LineItem = {
  id: string
  cartonName: string
  quantity: number
  rate: number | null
  planningStatus?: string
  dieMasterId?: string | null
  cartonId?: string | null
}

type PoReadiness = {
  tooling: { g: number; y: number; r: number }
  material: { grey: number; blue: number; green: number }
  production: { grey: number; blue: number; green: number }
}

type PurchaseOrder = {
  id: string
  poNumber: string
  poDate: string
  customer: { id: string; name: string }
  status: string
  remarks: string | null
  lineItems: LineItem[]
  value: number
  toolingCritical?: boolean
  readiness?: PoReadiness
  isPriority?: boolean
  /** Set when row matched via line-item name (server or client deep filter). */
  deepMatchProductName?: string | null
}

type ExecutiveMetrics = {
  totalActivePosCount: number
  pendingItemsSum: number
  liveOrderValue: number
  avgAgingDaysActive: number
}

type ToolingResult = { key: number; signal: 'green' | 'yellow' | 'red'; tooltip: string }

type DrawerPo = PurchaseOrder & { lineItems: LineItem[] }

const poMono = 'font-po-dashboard tabular-nums tracking-tight'

const EMPTY_READINESS: PoReadiness = {
  tooling: { g: 0, y: 0, r: 0 },
  material: { grey: 0, blue: 0, green: 0 },
  production: { grey: 0, blue: 0, green: 0 },
}

const PO_DASHBOARD_OPERATOR = 'Anik Dua'

function poAgeCalendarDays(poDate: string): number {
  const d = new Date(poDate)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const t = new Date()
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate())
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000))
}

function ageCellClass(days: number): string {
  if (days <= 3) return 'text-emerald-400'
  if (days <= 7) return 'text-ds-warning'
  return 'text-rose-400 animate-po-age-alert'
}

function MiniHubColumn({ parts }: { parts: { n: number; c: string }[] }) {
  const total = parts.reduce((s, p) => s + p.n, 0)
  return (
    <div className="h-1 min-w-[1.1rem] flex-1 overflow-hidden rounded-sm bg-ds-elevated/95 ring-1 ring-ds-line/50">
      {total === 0 ? (
        <div className="h-full w-full bg-ds-elevated/85" />
      ) : (
        <div className="flex h-full w-full flex-row">
          {parts.map((p, j) =>
            p.n > 0 ? (
              <div
                key={j}
                className={`h-full ${p.c} transition-[width] duration-300 ease-out`}
                style={{ width: `${(p.n / total) * 100}%` }}
              />
            ) : null,
          )}
        </div>
      )}
    </div>
  )
}

function ReadinessTriBar({ r }: { r: PoReadiness }) {
  return (
    <div
      className="flex w-[5.25rem] shrink-0 gap-px"
      title="Tooling · Material · Production (grey · hub blue · green)"
    >
      <MiniHubColumn
        parts={[
          { n: r.tooling.r, c: 'bg-ds-line/30' },
          { n: r.tooling.y, c: 'bg-sky-500' },
          { n: r.tooling.g, c: 'bg-emerald-500' },
        ]}
      />
      <MiniHubColumn
        parts={[
          { n: r.material.grey, c: 'bg-ds-line/30' },
          { n: r.material.blue, c: 'bg-sky-500' },
          { n: r.material.green, c: 'bg-emerald-500' },
        ]}
      />
      <MiniHubColumn
        parts={[
          { n: r.production.grey, c: 'bg-ds-line/30' },
          { n: r.production.blue, c: 'bg-sky-500' },
          { n: r.production.green, c: 'bg-emerald-500' },
        ]}
      />
    </div>
  )
}

function customerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function formatRupee(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

function canRevertConfirmedPoToDraft(po: PurchaseOrder): boolean {
  if (po.status !== 'confirmed') return false
  return !po.lineItems.some((li) => li.planningStatus === 'in_production')
}

function statusBadge(po: PurchaseOrder): { label: string; className: string } {
  if (po.status === 'closed') {
    return {
      label: 'Dispatched',
      className: 'bg-ds-warning/12 text-amber-800 ring-1 ring-ds-warning/35 dark:bg-ds-warning/8 dark:text-ds-warning',
    }
  }
  if (po.status === 'sent_to_planning') {
    return {
      label: 'In Planning',
      className: 'bg-cyan-500/14 text-cyan-800 ring-1 ring-cyan-500/40 dark:bg-cyan-500/20 dark:text-cyan-300',
    }
  }
  if (po.status === 'approved') {
    return {
      label: 'Approved',
      className: 'bg-violet-500/14 text-violet-800 ring-1 ring-violet-500/35 dark:bg-violet-500/20 dark:text-violet-300',
    }
  }
  if (po.status === 'confirmed') {
    const inProd = po.lineItems.some((li) => li.planningStatus === 'in_production')
    if (inProd) {
      return {
        label: 'In production',
        className: 'bg-indigo-500/14 text-indigo-800 ring-1 ring-indigo-500/35 dark:bg-indigo-500/20 dark:text-indigo-400',
      }
    }
    return {
      label: 'Confirmed',
      className: 'bg-emerald-500/14 text-emerald-800 ring-1 ring-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-300',
    }
  }
  return {
    label: 'Draft',
    className: 'bg-ds-elevated/30 text-ds-ink-muted ring-1 ring-ds-line/30',
  }
}

function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return debounced
}

/** In-page deep filter only — does not open global command palette or navigate to masters. */
function PoDeepFilterBar({
  value,
  onChange,
  onClear,
  filterActive,
}: {
  value: string
  onChange: (v: string) => void
  onClear: () => void
  filterActive: boolean
}) {
  return (
    <div className="flex w-full items-stretch gap-2">
      <div
        className={`group flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-ds-card/50 px-3 py-1.5 text-sm backdrop-blur-md transition-all duration-300 ${
          filterActive
            ? 'border-emerald-500/45 shadow-[0_0_16px_rgba(16,185,129,0.12)] ring-2 ring-emerald-500/30 dark:shadow-[0_0_32px_rgba(52,211,153,0.22),0_0_56px_rgba(245,158,11,0.12)] dark:ring-emerald-400/35'
            : 'border-ds-warning/45 shadow-[0_0_8px_rgba(245,158,11,0.10)] ring-1 ring-ds-warning/35 dark:shadow-[0_0_14px_rgba(245,158,11,0.12)] dark:ring-ds-warning/40'
        }`}
      >
        <Search className="h-4 w-4 text-ds-warning shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {value.trim().length >= 2 ? (
            <span className="shrink-0 text-emerald-400/90 text-xs sm:text-sm">Filtering:</span>
          ) : null}
          <input
            id="po-module-search"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="PO #, customer, or product on lines…"
            autoComplete="off"
            spellCheck={false}
            aria-label="Filter purchase orders"
            className="min-w-0 flex-1 bg-transparent py-1 text-ds-ink placeholder:text-ds-ink-faint focus:outline-none text-center sm:text-left text-sm"
          />
        </div>
      </div>
      {value.trim().length >= 2 ? (
        <button
          type="button"
          onClick={() => onClear()}
          className="shrink-0 self-center rounded-md border border-ds-line/50 bg-ds-card/60 px-2.5 py-2 text-ds-ink-faint backdrop-blur-md hover:border-ds-warning/40 hover:bg-ds-elevated/80 hover:text-ds-warning"
          title="Clear list filter"
          aria-label="Clear list filter"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  )
}

export default function PurchaseOrdersPage() {
  const [listFilterQuery, setListFilterQuery] = useState('')
  const [poDensity] = useUiDensity()
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null)
  const [selectedPoIds, setSelectedPoIds] = useState<Set<string>>(new Set())
  const [showColumnMenu, setShowColumnMenu] = useState(false)
  const [visibleCols, setVisibleCols] = useState({
    age: true,
    ready: true,
    lines: true,
    value: true,
    status: true,
  })
  const debouncedListFilter = useDebouncedValue(listFilterQuery, 200)
  const catalogHeavyRef = useRef(false)
  const prevDebouncedFilterRef = useRef('')
  const debouncedLiveRef = useRef('')
  debouncedLiveRef.current = debouncedListFilter

  const [list, setList] = useState<PurchaseOrder[]>([])
  const [metrics, setMetrics] = useState<ExecutiveMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [bulkUpdatingStatus, setBulkUpdatingStatus] = useState<string | null>(null)
  const [bulkRevertingDraft, setBulkRevertingDraft] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null)
  const [priorityBusyId, setPriorityBusyId] = useState<string | null>(null)
  const [drawerPoId, setDrawerPoId] = useState<string | null>(null)
  const [drawerPo, setDrawerPo] = useState<DrawerPo | null>(null)
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [toolingResults, setToolingResults] = useState<ToolingResult[] | null>(null)
  const debouncedAuditFilter = useDebouncedValue(listFilterQuery, 350)

  const loadPurchaseOrders = useCallback(
    async (opts?: { deepSearch?: string }) => {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (opts?.deepSearch && opts.deepSearch.trim().length >= 2) {
        params.set('deepSearch', opts.deepSearch.trim())
      }
      const poRes = await fetch(`/api/purchase-orders?${params.toString()}`)
      const poJson = await poRes.json()
      const arr = Array.isArray(poJson) ? (poJson as PurchaseOrder[]) : []
      if (!opts?.deepSearch) {
        catalogHeavyRef.current = arr.length >= 100
      }
      setList(arr)
      return arr
    },
    [status],
  )

  async function loadMetrics() {
    setMetricsLoading(true)
    try {
      const res = await fetch('/api/purchase-orders/executive-metrics')
      const json = (await res.json()) as ExecutiveMetrics
      if (res.ok) setMetrics(json)
      else setMetrics(null)
    } catch {
      setMetrics(null)
    } finally {
      setMetricsLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        await loadPurchaseOrders()
        if (cancelled) return
        if (
          catalogHeavyRef.current &&
          debouncedLiveRef.current.trim().length >= 2
        ) {
          await loadPurchaseOrders({ deepSearch: debouncedLiveRef.current.trim() })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [status, loadPurchaseOrders])

  useEffect(() => {
    const q = debouncedListFilter.trim()
    const prev = prevDebouncedFilterRef.current
    prevDebouncedFilterRef.current = q

    if (!catalogHeavyRef.current) return

    if (q.length >= 2) {
      let cancelled = false
      setLoading(true)
      void loadPurchaseOrders({ deepSearch: q }).finally(() => {
        if (!cancelled) setLoading(false)
      })
      return () => {
        cancelled = true
      }
    }

    if (prev.length >= 2 && q.length < 2) {
      let cancelled = false
      setLoading(true)
      void loadPurchaseOrders().finally(() => {
        if (!cancelled) setLoading(false)
      })
      return () => {
        cancelled = true
      }
    }
  }, [debouncedListFilter, loadPurchaseOrders])

  useEffect(() => {
    void loadMetrics()
  }, [])

  useEffect(() => {
    const q = debouncedAuditFilter.trim()
    if (q.length < 2) return
    void fetch('/api/purchase-orders/deep-filter-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    }).catch(() => {})
  }, [debouncedAuditFilter])

  useEffect(() => {
    if (!drawerPoId) {
      setDrawerPo(null)
      setToolingResults(null)
      return
    }
    let cancelled = false
    setDrawerLoading(true)
    void (async () => {
      try {
        const res = await fetch(`/api/purchase-orders/${drawerPoId}`)
        const data = (await res.json()) as DrawerPo & { error?: string }
        if (cancelled) return
        if (!res.ok || !data.lineItems) {
          setDrawerPo(null)
          return
        }
        const v = data.lineItems.reduce(
          (s, li) => s + (li.rate ? Number(li.rate) : 0) * li.quantity,
          0,
        )
        setDrawerPo({ ...data, value: v })
        const lines = data.lineItems.map((li, key) => ({
          key,
          cartonName: li.cartonName,
          quantity: String(li.quantity),
          cartonId: li.cartonId ?? '',
          dieMasterId: li.dieMasterId ?? '',
          toolingUnlinked: !(li.cartonId && li.dieMasterId),
        }))
        const tr = await fetch('/api/purchase-orders/tooling-line-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines }),
        })
        const tj = (await tr.json()) as { results?: ToolingResult[] }
        if (!cancelled) setToolingResults(Array.isArray(tj.results) ? tj.results : [])
      } catch {
        if (!cancelled) setToolingResults([])
      } finally {
        if (!cancelled) setDrawerLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [drawerPoId])

  const toolingBar = useMemo(() => {
    if (!toolingResults?.length) return { g: 0, y: 0, r: 0, total: 0 }
    let g = 0
    let y = 0
    let r = 0
    for (const t of toolingResults) {
      if (t.signal === 'green') g++
      else if (t.signal === 'yellow') y++
      else r++
    }
    return { g, y, r, total: toolingResults.length }
  }, [toolingResults])

  const viewRows = useMemo(() => {
    const qRaw = listFilterQuery.trim()
    const q = qRaw.toLowerCase()
    let rows: PurchaseOrder[]

    if (q.length < 2) {
      rows = list.map((p) => ({ ...p, deepMatchProductName: null }))
    } else {
      const matched = purchaseOrdersMatchingDeepQuery(list, qRaw)
      rows = matched.map((p) => {
        const poM = p.poNumber.toLowerCase().includes(q)
        const custM = (p.customer?.name ?? '').toLowerCase().includes(q)
        const lineHit = p.lineItems.find((li) => lineItemMatchesDrawerQuery(li.cartonName, qRaw))
        const deepMatchProductName =
          lineHit && !poM && !custM ? lineHit.cartonName : null
        return {
          ...p,
          deepMatchProductName: deepMatchProductName ?? p.deepMatchProductName ?? null,
        }
      })
    }

    return [...rows].sort((a, b) => {
      const paNum = a.isPriority === true ? 1 : 0
      const pbNum = b.isPriority === true ? 1 : 0
      if (pbNum !== paNum) return pbNum - paNum
      const aPushed = a.status === 'sent_to_planning' ? 1 : 0
      const bPushed = b.status === 'sent_to_planning' ? 1 : 0
      if (aPushed !== bPushed) return aPushed - bPushed
      return poAgeCalendarDays(b.poDate) - poAgeCalendarDays(a.poDate)
    })
  }, [list, listFilterQuery])

  /** Filtered KPIs: all POs that match the live filter (any status). */
  const filteredExecutiveKpi = useMemo((): ExecutiveMetrics => {
    const rows = viewRows
    if (rows.length === 0) {
      return {
        totalActivePosCount: 0,
        pendingItemsSum: 0,
        liveOrderValue: 0,
        avgAgingDaysActive: 0,
      }
    }
    const pendingItemsSum = rows.reduce(
      (s, p) => s + p.lineItems.reduce((a, li) => a + li.quantity, 0),
      0,
    )
    const liveOrderValue = rows.reduce((s, p) => s + p.value, 0)
    const avgAgingDaysActive =
      rows.reduce((s, p) => s + poAgeCalendarDays(p.poDate), 0) / rows.length
    return {
      totalActivePosCount: rows.length,
      pendingItemsSum,
      liveOrderValue,
      avgAgingDaysActive,
    }
  }, [viewRows])

  const kpi = listFilterQuery.trim().length >= 2 ? filteredExecutiveKpi : metrics
  const kpiLoading = listFilterQuery.trim().length < 2 && metricsLoading
  const resultSummary = useMemo(() => {
    const poCount = viewRows.length
    const lineCount = viewRows.reduce((s, p) => s + p.lineItems.length, 0)
    const value = viewRows.reduce((s, p) => s + (p.value ?? 0), 0)
    return `${poCount} POs · ${lineCount} lines · ${formatRupee(value)}`
  }, [viewRows])
  const pendingLineItemCount = useMemo(
    () => viewRows.reduce((s, p) => s + p.lineItems.length, 0),
    [viewRows],
  )

  const laneCounts = useMemo(
    () => ({
      all: viewRows.length,
      draft: viewRows.filter((p) => p.status === 'draft').length,
      confirmed: viewRows.filter((p) => p.status === 'confirmed').length,
      approved: viewRows.filter((p) => p.status === 'approved').length,
      inPlanning: viewRows.filter((p) => p.status === 'sent_to_planning').length,
      closed: viewRows.filter((p) => p.status === 'closed').length,
    }),
    [viewRows],
  )

  const allVisibleSelected = viewRows.length > 0 && viewRows.every((p) => selectedPoIds.has(p.id))
  const someVisibleSelected = viewRows.some((p) => selectedPoIds.has(p.id))

  const [masterProductExists, setMasterProductExists] = useState<boolean | null>(null)

  useEffect(() => {
    const q = listFilterQuery.trim()
    if (q.length < 2 || viewRows.length > 0) {
      setMasterProductExists(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(
          `/api/masters/cartons/product-exists?q=${encodeURIComponent(q)}`,
        )
        const j = (await res.json()) as { exists?: boolean }
        if (!cancelled) setMasterProductExists(Boolean(j.exists))
      } catch {
        if (!cancelled) setMasterProductExists(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [listFilterQuery, viewRows.length])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (e.key === '/') {
        e.preventDefault()
        const el = document.getElementById('po-module-search') as HTMLInputElement | null
        el?.focus()
        el?.select()
        return
      }
      if (!viewRows.length) return
      if (e.key.toLowerCase() === 'j') {
        e.preventDefault()
        const idx = Math.max(0, viewRows.findIndex((p) => p.id === selectedPoId))
        const next = viewRows[Math.min(viewRows.length - 1, idx + 1)]?.id ?? viewRows[0]!.id
        setSelectedPoId(next)
        return
      }
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const idx = Math.max(0, viewRows.findIndex((p) => p.id === selectedPoId))
        const next = viewRows[Math.max(0, idx - 1)]?.id ?? viewRows[0]!.id
        setSelectedPoId(next)
        return
      }
      if (e.key === 'Enter' && selectedPoId) {
        e.preventDefault()
        setDrawerPoId(selectedPoId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewRows, selectedPoId])

  useEffect(() => {
    if (!showColumnMenu) return
    const onClickAway = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-po-menu-root]')) return
      setShowColumnMenu(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [showColumnMenu])

  useEffect(() => {
    if (!viewRows.length) {
      setSelectedPoId(null)
      return
    }
    if (!selectedPoId || !viewRows.some((p) => p.id === selectedPoId)) {
      setSelectedPoId(viewRows[0]!.id)
    }
  }, [viewRows, selectedPoId])

  async function handleDelete(po: PurchaseOrder, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`Delete PO ${po.poNumber}? This cannot be undone.`)) return
    setDeletingId(po.id)
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to delete')
      toast.success(`${po.poNumber} deleted`)
      setList((prev) => prev.filter((p) => p.id !== po.id))
      if (drawerPoId === po.id) setDrawerPoId(null)
      void loadMetrics()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleConfirm(po: PurchaseOrder, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`Confirm PO ${po.poNumber}? All line items will be pushed to the Artwork queue.`)) return
    setConfirmingId(po.id)
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to confirm')
      toast.success(`${po.poNumber} confirmed — ${po.lineItems.length} item(s) pushed to Artwork queue`)
      setList((prev) => prev.map((p) => (p.id === po.id ? { ...p, status: 'confirmed' } : p)))
      if (drawerPo?.id === po.id) setDrawerPo((d) => (d ? { ...d, status: 'confirmed' } : d))
      void loadMetrics()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to confirm')
    } finally {
      setConfirmingId(null)
    }
  }

  async function downloadPoPdf(po: PurchaseOrder, e: React.MouseEvent) {
    e.stopPropagation()
    setPdfLoadingId(po.id)
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}/pdf`)
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error((j as { error?: string }).error || 'PDF failed')
      }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition')
      const match = cd?.match(/filename="([^"]+)"/)
      const filename = match?.[1] ?? `${po.poNumber.replace(/[^a-z0-9-_]/gi, '_')}.pdf`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success(`Downloaded ${filename}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'PDF download failed')
    } finally {
      setPdfLoadingId(null)
    }
  }

  async function togglePriority(po: PurchaseOrder, e: React.MouseEvent) {
    e.stopPropagation()
    const next = po.isPriority !== true
    setPriorityBusyId(po.id)
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPriority: next }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Could not update priority')
      setList((prev) => prev.map((p) => (p.id === po.id ? { ...p, isPriority: next } : p)))
      if (drawerPo?.id === po.id) setDrawerPo((d) => (d ? { ...d, isPriority: next } : d))
      broadcastIndustrialPriorityChange({
        source: 'po_is_priority',
        at: new Date().toISOString(),
      })
      toast.success(next ? 'PO pinned to top' : 'Priority cleared')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Priority update failed')
    } finally {
      setPriorityBusyId(null)
    }
  }

  const handleStatusChange = useCallback(
    async (po: PurchaseOrder, newStatus: string) => {
      if (newStatus === po.status) return
      setUpdatingId(po.id)
      try {
        const res = await fetch(`/api/purchase-orders/${po.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus, industrialVerification: true }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to update status')
        toast.success(`Status updated to ${newStatus}`)
        setList((prev) => prev.map((p) => (p.id === po.id ? { ...p, status: newStatus } : p)))
        if (drawerPo?.id === po.id) setDrawerPo((d) => (d ? { ...d, status: newStatus } : d))
        void loadMetrics()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to update')
      } finally {
        setUpdatingId(null)
      }
    },
    [drawerPo?.id],
  )

  const bulkUpdateStatus = useCallback(
    async (newStatus: 'confirmed' | 'approved') => {
      const targetRows = viewRows.filter((p) => selectedPoIds.has(p.id) && p.status !== newStatus)
      if (targetRows.length === 0) {
        toast.info(`No selected rows need status ${newStatus}`)
        return
      }
      setBulkUpdatingStatus(newStatus)
      let success = 0
      let failed = 0
      for (const po of targetRows) {
        try {
          const res = await fetch(`/api/purchase-orders/${po.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus, industrialVerification: true }),
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to update status')
          success += 1
        } catch {
          failed += 1
        }
      }
      if (success > 0) {
        setList((prev) =>
          prev.map((p) => (targetRows.some((t) => t.id === p.id) ? { ...p, status: newStatus } : p)),
        )
        if (drawerPo && targetRows.some((t) => t.id === drawerPo.id)) {
          setDrawerPo((d) => (d ? { ...d, status: newStatus } : d))
        }
        toast.success(`Updated to ${newStatus} • ${success} PO${success > 1 ? 's' : ''}`)
      }
      if (failed > 0) {
        toast.error(`Failed for ${failed} PO${failed > 1 ? 's' : ''}`)
      }
      setBulkUpdatingStatus(null)
      void loadMetrics()
    },
    [viewRows, selectedPoIds, drawerPo, loadMetrics],
  )

  const bulkRevertSelectedToDraft = useCallback(async () => {
    const targets = viewRows.filter(
      (p) => selectedPoIds.has(p.id) && canRevertConfirmedPoToDraft(p),
    )
    if (targets.length === 0) {
      toast.info('Select confirmed POs with no lines in production to move to Draft.')
      return
    }
    if (
      !confirm(
        `Move ${targets.length} PO${targets.length > 1 ? 's' : ''} back to Draft?`,
      )
    )
      return
    setBulkRevertingDraft(true)
    let ok = 0
    let fail = 0
    for (const po of targets) {
      try {
        const res = await fetch(`/api/purchase-orders/${po.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'draft', industrialVerification: true }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed')
        ok += 1
      } catch {
        fail += 1
      }
    }
    if (ok > 0) {
      const ids = new Set(targets.map((t) => t.id))
      setList((prev) => prev.map((p) => (ids.has(p.id) ? { ...p, status: 'draft' } : p)))
      if (drawerPo && ids.has(drawerPo.id)) setDrawerPo((d) => (d ? { ...d, status: 'draft' } : d))
      toast.success(`Moved ${ok} PO${ok > 1 ? 's' : ''} to Draft`)
      void loadMetrics()
    }
    if (fail > 0) toast.error(`Could not revert ${fail} PO${fail > 1 ? 's' : ''}`)
    setBulkRevertingDraft(false)
  }, [viewRows, selectedPoIds, drawerPo, loadMetrics])

  if (loading && list.length === 0) {
    return <div className="p-4 text-ds-ink-muted text-sm">Loading purchase orders…</div>
  }

  return (
    <div className="w-full space-y-3 px-3 py-3 pb-24 md:px-4 md:py-4">
      <div className="sticky top-0 z-40 rounded-md border border-ds-line/60 bg-ds-main/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-ds-main/90">
        <div className="flex flex-wrap items-center gap-2">
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
            Customer POs
          </span>
          <div className="min-w-[240px] flex-1">
            <PoDeepFilterBar
              value={listFilterQuery}
              onChange={setListFilterQuery}
              onClear={() => setListFilterQuery('')}
              filterActive={listFilterQuery.trim().length >= 2}
            />
          </div>
          <span className="rounded border border-ds-line/50 bg-ds-elevated/40 px-2 py-1 text-xs text-ds-ink-muted">
            {resultSummary}
          </span>
          <div className="relative" data-po-menu-root>
            <button
              type="button"
              onClick={() => setShowColumnMenu((v) => !v)}
              className="inline-flex h-8 items-center rounded-md border border-ds-line bg-ds-elevated/80 px-2 text-xs text-ds-ink shadow-sm"
            >
              Columns
            </button>
            {showColumnMenu ? (
              <div className="absolute right-0 z-50 mt-1 w-40 rounded-md border border-ds-line bg-ds-card p-2 text-xs shadow-lg">
                {(
                  [
                    ['age', 'Age'],
                    ['ready', 'Ready'],
                    ['lines', 'Lines'],
                    ['value', 'Value'],
                    ['status', 'Status'],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1.5 py-0.5 text-ds-ink-muted">
                    <input
                      type="checkbox"
                      checked={visibleCols[k]}
                      onChange={(e) => setVisibleCols((prev) => ({ ...prev, [k]: e.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
          <Link
            href="/orders/purchase-orders/new"
            className="inline-flex h-8 items-center justify-center rounded-md bg-ds-brand px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-ds-brand-hover"
          >
            New PO
          </Link>
          <span className="md:hidden">
            <CommandPaletteTriggerIcon />
          </span>
        </div>
        <div className="mt-2">
          <LaneCounterChips
            chips={[
              { key: 'all', label: 'All', count: laneCounts.all, active: status === '', onClick: () => setStatus(''), tone: 'brand' },
              { key: 'draft', label: 'Draft', count: laneCounts.draft, active: status === 'draft', onClick: () => setStatus('draft'), tone: 'warning' },
              { key: 'confirmed', label: 'Confirmed', count: laneCounts.confirmed, active: status === 'confirmed', onClick: () => setStatus('confirmed'), tone: 'success' },
              { key: 'approved', label: 'Approved', count: laneCounts.approved, active: status === 'approved', onClick: () => setStatus('approved'), tone: 'info' },
              { key: 'in_planning', label: 'In Planning', count: laneCounts.inPlanning, active: status === 'sent_to_planning', onClick: () => setStatus('sent_to_planning'), tone: 'brand' },
              { key: 'closed', label: 'Closed', count: laneCounts.closed, active: status === 'closed', onClick: () => setStatus('closed'), tone: 'danger' },
            ]}
          />
        </div>
      </div>

      <BulkActionBar
        selectedCount={selectedPoIds.size}
        left={
          <>
            <button
              type="button"
              onClick={() =>
                setSelectedPoIds((prev) => {
                  const next = new Set(prev)
                  if (allVisibleSelected) viewRows.forEach((p) => next.delete(p.id))
                  else viewRows.forEach((p) => next.add(p.id))
                  return next
                })
              }
              className="h-8 rounded-md border border-ds-line/60 px-2.5 text-xs font-medium text-ds-ink"
            >
              {allVisibleSelected ? 'Unselect visible' : 'Select visible'}
            </button>
            <button
              type="button"
              onClick={() => setSelectedPoIds(new Set(viewRows.filter((p) => p.status === 'draft').map((p) => p.id)))}
              className="h-8 rounded-md border border-ds-line/60 px-2.5 text-xs font-medium text-ds-ink"
            >
              Select drafts
            </button>
            <button
              type="button"
              onClick={() => setSelectedPoIds(new Set())}
              className="h-8 rounded-md border border-ds-line/60 px-2.5 text-xs font-medium text-ds-ink"
            >
              Clear
            </button>
          </>
        }
        right={
          <>
            <button
              type="button"
              onClick={() => void bulkUpdateStatus('confirmed')}
              disabled={selectedPoIds.size === 0 || bulkUpdatingStatus != null || bulkRevertingDraft}
              className="h-8 rounded-md border border-emerald-500/40 px-2.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-300"
            >
              {bulkUpdatingStatus === 'confirmed' ? 'Confirming…' : 'Bulk confirm'}
            </button>
            <button
              type="button"
              onClick={() => void bulkRevertSelectedToDraft()}
              disabled={selectedPoIds.size === 0 || bulkRevertingDraft || bulkUpdatingStatus != null}
              className="h-8 rounded-md border border-ds-line/60 px-2.5 text-xs font-semibold text-ds-ink hover:bg-ds-elevated/80 disabled:opacity-40"
            >
              {bulkRevertingDraft ? 'Reverting…' : 'Bulk move to draft'}
            </button>
            <button
              type="button"
              onClick={() => void bulkUpdateStatus('approved')}
              disabled={selectedPoIds.size === 0 || bulkUpdatingStatus != null || bulkRevertingDraft}
              className="h-8 rounded-md border border-sky-500/40 px-2.5 text-xs font-semibold text-sky-700 hover:bg-sky-500/10 disabled:opacity-40 dark:text-sky-300"
            >
              {bulkUpdatingStatus === 'approved' ? 'Approving…' : 'Bulk approve'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectedPoIds.size === 0) return
                const first = viewRows.find((p) => selectedPoIds.has(p.id))
                if (first) setDrawerPoId(first.id)
              }}
              disabled={selectedPoIds.size === 0}
              className="h-8 rounded-md border border-ds-brand/40 px-2.5 text-xs font-semibold text-ds-brand disabled:opacity-40"
            >
              Open first selected
            </button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 md:gap-3">
        <div className="rounded-md border border-border bg-card/80 px-3 py-2 backdrop-blur-md shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
            Total active POs
          </div>
          <div className={`mt-0.5 ds-typo-kpi text-ds-ink ${poMono}`}>
            {kpiLoading ? '—' : (kpi?.totalActivePosCount ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-xs text-ds-ink-faint mt-0.5">
            {listFilterQuery.trim().length >= 2 ? 'POs matching filter' : 'Confirmed orders only'}
          </div>
        </div>
        <div className="rounded-md border border-border bg-card/80 px-3 py-2 backdrop-blur-md shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
            Pending line count
          </div>
          <div className={`mt-0.5 ds-typo-kpi text-ds-ink ${poMono}`}>
            {kpiLoading ? '—' : pendingLineItemCount.toLocaleString('en-IN')}
          </div>
          <div className="text-xs text-ds-ink-faint mt-0.5">
            {listFilterQuery.trim().length >= 2 ? 'Lines · matching POs' : 'Lines · confirmed POs'}
          </div>
        </div>
        <div className="rounded-md border border-border bg-card/80 px-3 py-2 backdrop-blur-md shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
            Pending line items
          </div>
          <div className={`mt-0.5 ds-typo-kpi text-ds-ink ${poMono}`}>
            {kpiLoading ? '—' : (kpi?.pendingItemsSum ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-xs text-ds-ink-faint mt-0.5">
            {listFilterQuery.trim().length >= 2 ? 'Σ qty · matching POs' : 'Σ qty · confirmed POs'}
          </div>
        </div>
        <div className="rounded-md border border-emerald-500/30 bg-ds-main/35 px-3 py-2 backdrop-blur-md shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-emerald-500/90">
            Live order book
          </div>
          <div className={`mt-0.5 ds-typo-kpi text-emerald-700 dark:text-emerald-300 ${poMono}`}>
            {kpiLoading ? '—' : formatRupee(kpi?.liveOrderValue ?? 0)}
          </div>
          <div className="text-xs text-emerald-700/80 mt-0.5">
            {listFilterQuery.trim().length >= 2 ? '₹ filtered order book' : '₹ total · confirmed'}
          </div>
        </div>
        <div className="rounded-md border border-ds-warning/30 bg-ds-main/35 px-3 py-2 backdrop-blur-md shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-ds-warning/90">
            System velocity
          </div>
          <div className={`mt-0.5 ds-typo-kpi text-ds-warning ${poMono}`}>
            {kpiLoading
              ? '—'
              : `${(kpi?.avgAgingDaysActive ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} d`}
          </div>
          <div className="text-xs text-ds-warning mt-0.5">
            {listFilterQuery.trim().length >= 2 ? 'Avg. age · matching POs' : 'Avg. age · confirmed'}
          </div>
        </div>
      </div>

      <EnterpriseTableShell>
        <table className="w-full min-w-[900px] table-fixed border-collapse text-left text-sm leading-tight">
          <thead className="sticky top-0 z-[30]">
            <tr className="border-b border-border bg-card text-muted-foreground backdrop-blur-md">
              <th className="w-8 px-1 py-0.5 font-semibold text-center" aria-label="Select">
                <input
                  type="checkbox"
                  aria-label="Select all visible purchase orders"
                  checked={allVisibleSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected
                  }}
                  onChange={() =>
                    setSelectedPoIds((prev) => {
                      const next = new Set(prev)
                      if (allVisibleSelected) viewRows.forEach((p) => next.delete(p.id))
                      else viewRows.forEach((p) => next.add(p.id))
                      return next
                    })
                  }
                  className="h-3.5 w-3.5 accent-ds-brand"
                />
              </th>
              <th className="w-[13rem] px-1.5 py-0.5 font-semibold">PO #</th>
              <th className="w-[12rem] px-1.5 py-0.5 font-semibold">Customer</th>
              <th className="w-[6.5rem] px-1.5 py-0.5 font-semibold whitespace-nowrap">Date</th>
              {visibleCols.age ? <th className="w-[5.5rem] px-1.5 py-0.5 font-semibold whitespace-nowrap text-right">Age</th> : null}
              {visibleCols.ready ? <th className="w-[7rem] px-1.5 py-0.5 font-semibold">Ready</th> : null}
              {visibleCols.lines ? <th className="w-[4rem] px-1.5 py-0.5 font-semibold text-right">Lines</th> : null}
              {visibleCols.value ? <th className="w-[6.75rem] px-1.5 py-0.5 font-semibold text-right">Value</th> : null}
              {visibleCols.status ? <th className="w-[9rem] px-1.5 py-0.5 font-semibold">Status</th> : null}
              <th className="w-[10.5rem] px-1.5 py-0.5 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {viewRows.map((po) => {
              const badge = statusBadge(po)
              const ageDays = poAgeCalendarDays(po.poDate)
              const readiness = po.readiness ?? EMPTY_READINESS
              const criticalAge = ageDays > 10 && po.status !== 'closed'
              const pushedToPlanning = po.status === 'sent_to_planning'
              return (
                <tr
                  key={po.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDrawerPoId(po.id)}
                  onMouseEnter={() => setSelectedPoId(po.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setDrawerPoId(po.id)
                    }
                  }}
                  onFocus={() => setSelectedPoId(po.id)}
                  className={`group/po cursor-pointer border-b border-ds-line/50 transition-[background,box-shadow] duration-150 ${
                    po.isPriority === true
                      ? INDUSTRIAL_PRIORITY_ROW_CLASS
                      : pushedToPlanning
                        ? 'bg-emerald-500/10 hover:bg-emerald-500/15 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/24'
                        : criticalAge
                          ? 'bg-amber-500/8 hover:bg-amber-500/12'
                          : po.status === 'closed'
                            ? 'bg-ds-elevated/25 hover:bg-ds-elevated/35'
                        : 'hover:bg-accent'
                  } ${selectedPoId === po.id ? 'ring-1 ring-inset ring-ds-brand/35' : ''}`}
                >
                  <td className="px-0.5 py-0 align-middle text-center">
                    <div className="flex items-center justify-center gap-1">
                    <input
                      type="checkbox"
                      aria-label="Select row"
                      checked={selectedPoIds.has(po.id)}
                      onChange={(e) => {
                        e.stopPropagation()
                        setSelectedPoIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(po.id)) next.delete(po.id)
                          else next.add(po.id)
                          return next
                        })
                      }}
                      className="h-3.5 w-3.5 accent-ds-brand"
                    />
                    <button
                      type="button"
                      title={po.isPriority === true ? 'Unpin priority' : 'Pin priority'}
                      aria-pressed={po.isPriority === true}
                      aria-label={po.isPriority === true ? 'Unpin priority' : 'Pin priority'}
                      disabled={priorityBusyId === po.id}
                      onClick={(e) => void togglePriority(po, e)}
                      className={`${ICON_BUTTON_TIGHT} text-ds-ink-faint hover:bg-ds-elevated/80`}
                    >
                      <Star
                        className={`h-3.5 w-3.5 ${
                          po.isPriority === true
                            ? INDUSTRIAL_PRIORITY_STAR_ICON_CLASS
                            : 'text-ds-ink-faint group-hover/po:text-ds-ink-muted'
                        }`}
                        strokeWidth={2}
                      />
                    </button>
                    </div>
                  </td>
                  <td className={`w-[13rem] px-1.5 align-middle ${poDensity === 'dense' ? 'py-0.5' : 'py-1.5'}`}>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-1">
                        <span
                          className={`${poMono} min-w-0 break-all text-xs font-bold ${pushedToPlanning ? 'text-emerald-700 dark:text-emerald-300' : 'text-ds-warning'}`}
                          title={po.poNumber}
                        >
                          {po.poNumber}
                        </span>
                        {po.toolingCritical ? (
                          <span title="Critical tooling on one or more lines">
                            <AlertTriangle className="h-3 w-3 text-rose-400 shrink-0" aria-hidden />
                          </span>
                        ) : null}
                      </div>
                      {po.deepMatchProductName ? (
                        <div
                          className={`line-clamp-2 break-words text-xs leading-snug ${pushedToPlanning ? 'text-emerald-700/90 dark:text-emerald-300/90' : 'text-ds-warning/85'}`}
                          title={`Matched line: ${po.deepMatchProductName}`}
                        >
                          Matched: {po.deepMatchProductName}
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td className={`w-[12rem] px-1.5 align-middle ${poDensity === 'dense' ? 'py-0.5' : 'py-1.5'}`}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--bg-muted)] text-xs font-bold text-[var(--brand-primary)] ring-1 ring-[var(--border)]"
                        aria-hidden
                      >
                        {customerInitials(po.customer?.name ?? '')}
                      </span>
                      <span
                        className="line-clamp-2 break-words text-xs text-[var(--text-primary)] md:text-xs"
                        title={po.customer?.name}
                      >
                        {po.customer?.name}
                      </span>
                    </div>
                  </td>
                  <td className={`px-1.5 align-middle whitespace-nowrap text-ds-ink-muted ${poMono} ${poDensity === 'dense' ? 'py-0.5' : 'py-1.5'}`}>
                    {new Date(po.poDate).toLocaleDateString('en-IN', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </td>
                  {visibleCols.age ? (
                    <td
                      title={criticalAge ? 'Critical' : undefined}
                      className={`px-1.5 align-middle text-right whitespace-nowrap ${poMono} font-medium ${ageCellClass(ageDays)} ${poDensity === 'dense' ? 'py-0.5' : 'py-1.5'}`}
                    >
                      {ageDays} {ageDays === 1 ? 'Day' : 'Days'}
                    </td>
                  ) : null}
                  {visibleCols.ready ? (
                    <td className={`px-1.5 align-middle ${poDensity === 'dense' ? 'py-0.5' : 'py-1.5'}`}>
                      <ReadinessTriBar r={readiness} />
                    </td>
                  ) : null}
                  {visibleCols.lines ? (
                    <td className={`px-1.5 align-middle text-right ${poMono} text-ds-ink-muted ${poDensity === 'dense' ? 'py-0.5' : 'py-1.5'}`}>
                      {po.lineItems.length}
                    </td>
                  ) : null}
                  {visibleCols.value ? (
                    <td className={`px-1.5 align-middle text-right ${poMono} text-ds-ink ${poDensity === 'dense' ? 'py-0.5' : 'py-1.5'}`}>
                      <span className="mr-0.5 text-xs text-ds-ink-faint">₹</span>
                      {(po.value ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </td>
                  ) : null}
                  {visibleCols.status ? (
                    <td className={`px-1.5 align-middle ${poDensity === 'dense' ? 'py-0.5' : 'py-1.5'}`}>
                      <div className="flex flex-col items-start gap-0.5">
                        <span className={`${STATUS_CHIP_BASE} ${badge.className}`}>{badge.label}</span>
                        {pushedToPlanning ? (
                          <span className={PUSHED_CHIP_CLASS}>
                            Pushed {formatShortTimeAgo(po.poDate) ?? 'just now'}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                  <td className={`px-1.5 align-middle text-right ${poDensity === 'dense' ? 'py-0.5' : 'py-1.5'}`}>
                    <div
                      className="flex flex-wrap items-center justify-end gap-1 leading-none"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        title="Download PDF"
                        aria-label="Download PDF"
                        disabled={pdfLoadingId === po.id}
                        onClick={(e) => void downloadPoPdf(po, e)}
                        className={`${ICON_BUTTON_BASE} text-ds-ink-muted hover:bg-ds-elevated/90 hover:text-ds-warning`}
                      >
                        <FileDown className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        title="Open spotlight drawer"
                        aria-label="Edit purchase order in drawer"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDrawerPoId(po.id)
                        }}
                        className="inline-flex items-center justify-center rounded-md border border-ds-line/40 bg-ds-card/40 px-1.5 py-1 text-ds-ink-muted hover:border-ds-warning/45 hover:bg-ds-warning/8 hover:text-ds-warning"
                      >
                        <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>
                      {po.status === 'draft' && (
                        <button
                          type="button"
                          onClick={(e) => handleConfirm(po, e)}
                          disabled={confirmingId === po.id}
                        className={`${ACTION_PILL_BASE} min-w-0 border-transparent bg-emerald-600 px-1.5 py-px text-xs text-primary-foreground hover:bg-emerald-700`}
                        >
                          {confirmingId === po.id ? '…' : 'Confirm'}
                        </button>
                      )}
                      <button
                        type="button"
                        title="Delete"
                        aria-label="Delete purchase order"
                        onClick={(e) => handleDelete(po, e)}
                        disabled={deletingId === po.id}
                        className={`${ICON_BUTTON_BASE} text-ds-ink-muted hover:bg-red-950/50 hover:text-red-300`}
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </EnterpriseTableShell>

      {list.length === 0 && !loading ? (
        <p className="text-ds-ink-faint text-center py-8 text-sm">No rows in this queue yet.</p>
      ) : viewRows.length === 0 && listFilterQuery.trim().length >= 2 && !loading ? (
        <p className="text-ds-ink-faint text-center py-8 text-sm max-w-lg mx-auto leading-relaxed">
          {masterProductExists === true ? (
            <>
              Product &apos;{listFilterQuery.trim()}&apos; found in Master, but no active Purchase
              Orders contain this item.
            </>
          ) : (
            <>No rows match current view or filters. Clear filters to see all rows.</>
          )}
        </p>
      ) : null}

      <SlideOverPanel
        title={drawerPo ? `PO ${drawerPo.poNumber}` : 'Purchase order'}
        isOpen={Boolean(drawerPoId)}
        onClose={() => setDrawerPoId(null)}
        backdropClassName="bg-ds-main/50 backdrop-blur-[1.5px]"
        panelClassName="border-l border-ds-line/80 bg-ds-card text-ds-ink shadow-2xl"
      >
        {drawerLoading || !drawerPo ? (
          <p className="text-ds-ink-faint text-sm">Loading…</p>
        ) : (
          <div className="space-y-4 text-sm text-foreground">
            <p className="text-xs text-ds-ink-faint leading-snug">
              Default operator / metadata:{' '}
              <span className="text-ds-ink-muted font-medium">{PO_DASHBOARD_OPERATOR}</span>
            </p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs text-ds-ink-faint">Customer</div>
                <div className="font-medium text-ds-ink">{drawerPo.customer?.name}</div>
              </div>
              <div className={`text-right ${poMono} text-ds-warning`}>
                <div className="text-xs text-ds-ink-faint uppercase">Value</div>
                {formatRupee(drawerPo.value)}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
                Tooling readiness
              </div>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-ds-card ring-1 ring-ds-line/40">
                {toolingBar.total > 0 ? (
                  <>
                    <div
                      className="h-full bg-emerald-500 transition-[width]"
                      style={{ width: `${(toolingBar.g / toolingBar.total) * 100}%` }}
                    />
                    <div
                      className="h-full bg-ds-warning transition-[width]"
                      style={{ width: `${(toolingBar.y / toolingBar.total) * 100}%` }}
                    />
                    <div
                      className="h-full bg-rose-500 transition-[width]"
                      style={{ width: `${(toolingBar.r / toolingBar.total) * 100}%` }}
                    />
                  </>
                ) : (
                  <div className="h-full flex-1 bg-ds-elevated/80" />
                )}
              </div>
              <div className="mt-1 text-xs text-ds-ink-faint tabular-nums">
                Green {toolingBar.g} · Yellow {toolingBar.y} · Red {toolingBar.r}{' '}
                <span className="text-ds-ink-faint">/ {toolingBar.total} lines</span>
              </div>
            </div>

            <div>
              <PoDrawerSpotlightLines
                key={drawerPo.id}
                lineItems={drawerPo.lineItems}
                toolingResults={toolingResults}
                spotlightQuery={listFilterQuery.trim().length >= 2 ? listFilterQuery.trim() : ''}
                poMono={poMono}
              />
              {listFilterQuery.trim().length >= 2 ? (
                <p className="mt-2 text-xs text-ds-ink-faint leading-snug">
                  Deep Audit Performed by Anik Dua.
                </p>
              ) : null}
            </div>

            <div className="space-y-2 border-t border-ds-line/40 pt-3">
              <label className="block text-xs uppercase tracking-wider text-ds-ink-faint">PO status</label>
              <select
                value={drawerPo.status}
                disabled={updatingId === drawerPo.id}
                onChange={(e) => handleStatusChange(drawerPo, e.target.value)}
                className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs text-foreground"
              >
                <option value="draft">draft</option>
                <option value="confirmed">confirmed</option>
                <option value="approved">approved</option>
                <option value="sent_to_planning">sent to planning</option>
                <option value="closed">closed</option>
              </select>
            </div>

            <Link
              href={`/orders/purchase-orders/${drawerPo.id}`}
              className="block w-full text-center text-xs text-ds-ink-faint hover:text-ds-warning underline-offset-2 hover:underline"
            >
              Open full-page editor (advanced)
            </Link>
          </div>
        )}
      </SlideOverPanel>
    </div>
  )
}
