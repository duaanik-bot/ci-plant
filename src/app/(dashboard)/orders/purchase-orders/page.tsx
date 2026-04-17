'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { toast } from 'sonner'
import { Search, AlertTriangle, FileDown, Pencil, Star, Trash2, X } from 'lucide-react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import {
  useCommandPalette,
  CommandPaletteTriggerIcon,
} from '@/components/command-palette/CommandPalette'

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
}

type Customer = { id: string; name: string }

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
  if (days <= 7) return 'text-amber-400'
  return 'text-rose-400 animate-po-age-alert'
}

function MiniHubColumn({ parts }: { parts: { n: number; c: string }[] }) {
  const total = parts.reduce((s, p) => s + p.n, 0)
  return (
    <div className="h-1 min-w-[1.1rem] flex-1 overflow-hidden rounded-sm bg-slate-800/95 ring-1 ring-slate-700/70">
      {total === 0 ? (
        <div className="h-full w-full bg-slate-700/85" />
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
          { n: r.tooling.r, c: 'bg-slate-600' },
          { n: r.tooling.y, c: 'bg-sky-500' },
          { n: r.tooling.g, c: 'bg-emerald-500' },
        ]}
      />
      <MiniHubColumn
        parts={[
          { n: r.material.grey, c: 'bg-slate-600' },
          { n: r.material.blue, c: 'bg-sky-500' },
          { n: r.material.green, c: 'bg-emerald-500' },
        ]}
      />
      <MiniHubColumn
        parts={[
          { n: r.production.grey, c: 'bg-slate-600' },
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

function statusBadge(po: PurchaseOrder): { label: string; className: string } {
  if (po.status === 'closed') {
    return {
      label: 'Dispatched',
      className: 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/30',
    }
  }
  if (po.status === 'confirmed') {
    const inProd = po.lineItems.some((li) => li.planningStatus === 'in_production')
    if (inProd) {
      return {
        label: 'In production',
        className: 'bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/35',
      }
    }
    return {
      label: 'Confirmed',
      className: 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30',
    }
  }
  return {
    label: 'Draft',
    className: 'bg-slate-600/25 text-slate-300 ring-1 ring-slate-500/30',
  }
}

function NeonCommandTrigger({
  pageActive,
  paletteQuery,
  onClearQuery,
}: {
  pageActive: boolean
  paletteQuery: string
  onClearQuery: () => void
}) {
  const { open } = useCommandPalette()
  const [kbd, setKbd] = useState('Cmd + K')
  useEffect(() => {
    const mac = /Mac|iPod|iPhone|iPad/i.test(navigator.userAgent)
    setKbd(mac ? 'Cmd + K' : 'Ctrl + K')
  }, [])
  return (
    <div className="flex w-full max-w-2xl mx-auto items-stretch gap-2">
      <button
        type="button"
        onClick={() => open()}
        className={`group min-w-0 flex-1 flex items-center gap-2 rounded-xl border bg-slate-900/50 px-4 py-2.5 text-left text-sm backdrop-blur-md transition-all duration-300 ${
          pageActive
            ? 'border-emerald-500/45 shadow-[0_0_32px_rgba(52,211,153,0.22),0_0_56px_rgba(245,158,11,0.12)] ring-2 ring-emerald-400/35 hover:border-amber-400/70 hover:shadow-[0_0_36px_rgba(245,158,11,0.22)]'
            : 'border-amber-500/45 shadow-[0_0_14px_rgba(245,158,11,0.12)] ring-1 ring-amber-400/25 hover:border-amber-400/80 hover:shadow-[0_0_20px_rgba(245,158,11,0.2)] hover:ring-amber-300/35'
        }`}
        aria-label="Open command palette"
      >
        <Search className="h-4 w-4 text-amber-400 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-center text-slate-400 group-hover:text-slate-200 sm:text-left">
          {paletteQuery.trim().length >= 2 ? (
            <>
              <span className="text-emerald-400/90">Filtering:</span>{' '}
              <span className="text-slate-200">{paletteQuery.trim()}</span>
            </>
          ) : (
            <>
              Search POs, Customers, or Dies…{' '}
              <span className="text-amber-500/95">({kbd})</span>
            </>
          )}
        </span>
      </button>
      {paletteQuery.trim().length >= 2 ? (
        <button
          type="button"
          onClick={() => onClearQuery()}
          className="shrink-0 self-center rounded-xl border border-slate-600/80 bg-slate-900/60 px-2.5 py-2 text-slate-500 backdrop-blur-md hover:border-amber-500/40 hover:bg-slate-800/80 hover:text-amber-300"
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
  const pathname = usePathname()
  const commandBarActive = pathname === '/orders/purchase-orders'
  const { paletteQuery, clearPaletteQuery } = useCommandPalette()

  const [list, setList] = useState<PurchaseOrder[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [metrics, setMetrics] = useState<ExecutiveMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null)
  const [priorityBusyId, setPriorityBusyId] = useState<string | null>(null)
  const [drawerPoId, setDrawerPoId] = useState<string | null>(null)
  const [drawerPo, setDrawerPo] = useState<DrawerPo | null>(null)
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [toolingResults, setToolingResults] = useState<ToolingResult[] | null>(null)

  async function load() {
    try {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (customerId) params.set('customerId', customerId)
      const [poRes, custRes] = await Promise.all([
        fetch(`/api/purchase-orders?${params.toString()}`),
        fetch('/api/masters/customers'),
      ])
      const poJson = await poRes.json()
      const custJson = await custRes.json()
      setList(Array.isArray(poJson) ? poJson : [])
      setCustomers(Array.isArray(custJson) ? custJson : [])
    } finally {
      setLoading(false)
    }
  }

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
    setLoading(true)
    void load()
  }, [status, customerId])

  useEffect(() => {
    void loadMetrics()
  }, [])

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
    const q = paletteQuery.trim().toLowerCase()
    let rows = list
    if (q.length >= 2) {
      rows = list.filter(
        (p) =>
          p.poNumber.toLowerCase().includes(q) ||
          (p.customer?.name ?? '').toLowerCase().includes(q),
      )
    }
    return [...rows].sort((a, b) => {
      const paNum = a.isPriority === true ? 1 : 0
      const pbNum = b.isPriority === true ? 1 : 0
      if (pbNum !== paNum) return pbNum - paNum
      return poAgeCalendarDays(b.poDate) - poAgeCalendarDays(a.poDate)
    })
  }, [list, paletteQuery])

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
          body: JSON.stringify({ status: newStatus }),
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

  if (loading && list.length === 0) {
    return <div className="p-4 text-slate-400 text-sm">Loading purchase orders…</div>
  }

  return (
    <div className="p-3 md:p-4 max-w-[1480px] mx-auto space-y-4 pb-24">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-lg md:text-xl font-bold text-amber-400 tracking-tight">
            Predictive command center · Customer POs
          </h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Priority pinning · aging & readiness · operator {PO_DASHBOARD_OPERATOR}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/orders/designing"
            className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-xs"
          >
            Prepress →
          </Link>
          <Link
            href="/orders/purchase-orders/new"
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold"
          >
            New PO
          </Link>
          <span className="md:hidden">
            <CommandPaletteTriggerIcon />
          </span>
        </div>
      </div>

      <div className="px-1 flex justify-center">
        <div className="w-full max-w-2xl">
          <NeonCommandTrigger
            pageActive={commandBarActive}
            paletteQuery={paletteQuery}
            onClearQuery={clearPaletteQuery}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
        <div className="rounded-xl border border-white/10 bg-slate-950/35 px-3 py-2 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_0_24px_rgba(16,185,129,0.05)]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Total active POs
          </div>
          <div className={`mt-0.5 text-xl md:text-2xl font-semibold text-slate-100 ${poMono}`}>
            {metricsLoading ? '—' : (metrics?.totalActivePosCount ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] text-slate-600 mt-0.5">Confirmed orders only</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-slate-950/35 px-3 py-2 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Pending line items
          </div>
          <div className={`mt-0.5 text-xl md:text-2xl font-semibold text-slate-100 ${poMono}`}>
            {metricsLoading ? '—' : (metrics?.pendingItemsSum ?? 0).toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] text-slate-600 mt-0.5">Σ qty · confirmed POs</div>
        </div>
        <div className="rounded-xl border border-emerald-500/30 bg-slate-950/35 px-3 py-2 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_0_28px_rgba(16,185,129,0.14)]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500/90">
            Live order book
          </div>
          <div className={`mt-0.5 text-xl md:text-2xl font-semibold text-emerald-300 ${poMono}`}>
            {metricsLoading ? '—' : formatRupee(metrics?.liveOrderValue ?? 0)}
          </div>
          <div className="text-[10px] text-emerald-700/80 mt-0.5">₹ total · confirmed</div>
        </div>
        <div className="rounded-xl border border-amber-500/35 bg-slate-950/35 px-3 py-2 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_0_26px_rgba(245,158,11,0.12)]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-500/90">
            System velocity
          </div>
          <div className={`mt-0.5 text-xl md:text-2xl font-semibold text-amber-200 ${poMono}`}>
            {metricsLoading
              ? '—'
              : `${(metrics?.avgAgingDaysActive ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} d`}
          </div>
          <div className="text-[10px] text-amber-700/75 mt-0.5">Avg. age · confirmed</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs items-center">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-2 py-1 rounded-lg bg-slate-900/80 border border-slate-600 text-white"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="confirmed">Confirmed</option>
          <option value="closed">Closed</option>
        </select>
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-2 py-1 rounded-lg bg-slate-900/80 border border-slate-600 text-white min-w-[160px]"
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700/80 ring-1 ring-white/5">
        <table className="w-full text-left text-[10px] md:text-[11px] border-collapse min-w-[920px] leading-tight">
          <thead className="sticky top-0 z-[30]">
            <tr className="border-b border-slate-700/90 bg-[#0B0F1A]/92 backdrop-blur-md text-slate-400 shadow-[inset_0_-1px_0_0_rgb(51_65_85)]">
              <th className="w-8 px-1 py-1 font-semibold text-center" aria-label="Priority">
                ★
              </th>
              <th className="px-1.5 py-1 font-semibold">PO #</th>
              <th className="px-1.5 py-1 font-semibold">Customer</th>
              <th className="px-1.5 py-1 font-semibold whitespace-nowrap">Date</th>
              <th className="px-1.5 py-1 font-semibold whitespace-nowrap text-right">Age</th>
              <th className="px-1.5 py-1 font-semibold">Ready</th>
              <th className="px-1.5 py-1 font-semibold text-right">Lines</th>
              <th className="px-1.5 py-1 font-semibold text-right">Value</th>
              <th className="px-1.5 py-1 font-semibold">Status</th>
              <th className="px-1.5 py-1 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {viewRows.map((po, idx) => {
              const badge = statusBadge(po)
              const ageDays = poAgeCalendarDays(po.poDate)
              const readiness = po.readiness ?? EMPTY_READINESS
              const criticalAge = ageDays > 10 && po.status !== 'closed'
              return (
                <tr
                  key={po.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDrawerPoId(po.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setDrawerPoId(po.id)
                    }
                  }}
                  className={`group/po cursor-pointer border-b border-slate-800/80 transition-[background,box-shadow] duration-150 ${
                    idx % 2 === 0 ? 'bg-[#0B0F1A]' : 'bg-[#161B26]'
                  } hover:brightness-110 hover:shadow-[inset_0_0_0_1px_rgba(251,191,36,0.22),0_0_12px_rgba(251,191,36,0.06)]`}
                >
                  <td className="px-0.5 py-px align-middle text-center">
                    <button
                      type="button"
                      title={po.isPriority === true ? 'Unpin priority' : 'Pin priority'}
                      aria-pressed={po.isPriority === true}
                      aria-label={po.isPriority === true ? 'Unpin priority' : 'Pin priority'}
                      disabled={priorityBusyId === po.id}
                      onClick={(e) => void togglePriority(po, e)}
                      className="inline-flex rounded-md p-0.5 text-slate-500 transition-colors hover:bg-slate-800/80 disabled:opacity-40"
                    >
                      <Star
                        className={`h-3.5 w-3.5 ${
                          po.isPriority === true
                            ? 'fill-amber-400 text-amber-400 drop-shadow-[0_0_6px_rgba(251,191,36,0.55)]'
                            : 'text-slate-500 group-hover/po:text-slate-400'
                        }`}
                        strokeWidth={2}
                      />
                    </button>
                  </td>
                  <td className="px-1.5 py-px align-middle">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={`${poMono} font-bold text-amber-300`}>{po.poNumber}</span>
                      {po.toolingCritical ? (
                        <span title="Critical tooling on one or more lines">
                          <AlertTriangle className="h-3 w-3 text-rose-400 shrink-0" aria-hidden />
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-1.5 py-px align-middle">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-slate-700 to-slate-800 text-[8px] font-bold text-amber-200/90 ring-1 ring-slate-600/80"
                        aria-hidden
                      >
                        {customerInitials(po.customer?.name ?? '')}
                      </span>
                      <span className="truncate text-slate-200 text-[10px] md:text-[11px]">{po.customer?.name}</span>
                    </div>
                  </td>
                  <td className={`px-1.5 py-px align-middle whitespace-nowrap text-slate-400 ${poMono}`}>
                    {new Date(po.poDate).toLocaleDateString('en-IN', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </td>
                  <td
                    title={criticalAge ? 'Critical' : undefined}
                    className={`px-1.5 py-px align-middle text-right whitespace-nowrap ${poMono} font-medium ${ageCellClass(ageDays)}`}
                  >
                    {ageDays} {ageDays === 1 ? 'Day' : 'Days'}
                  </td>
                  <td className="px-1.5 py-px align-middle">
                    <ReadinessTriBar r={readiness} />
                  </td>
                  <td className={`px-1.5 py-px align-middle text-right ${poMono} text-slate-300`}>
                    {po.lineItems.length}
                  </td>
                  <td className={`px-1.5 py-px align-middle text-right ${poMono} text-slate-100`}>
                    <span className="text-slate-500 text-[9px] mr-0.5">₹</span>
                    {(po.value ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </td>
                  <td className="px-1.5 py-px align-middle">
                    <span
                      className={`inline-flex rounded-md px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  </td>
                  <td className="px-1.5 py-px align-middle text-right">
                    <div
                      className="flex flex-wrap items-center justify-end gap-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        title="Download PDF"
                        aria-label="Download PDF"
                        disabled={pdfLoadingId === po.id}
                        onClick={(e) => void downloadPoPdf(po, e)}
                        className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-800/90 disabled:opacity-40 group-hover/po:text-amber-400 hover:text-amber-300"
                      >
                        <FileDown className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>
                      <Link
                        href={`/orders/purchase-orders/${po.id}`}
                        title="Quick edit"
                        aria-label="Edit purchase order"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center justify-center rounded-md border border-transparent bg-transparent px-1.5 py-1 text-slate-400 transition-colors hover:border-amber-500/45 hover:bg-amber-500/10 hover:text-amber-400"
                      >
                        <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                      </Link>
                      {po.status === 'draft' && (
                        <button
                          type="button"
                          onClick={(e) => handleConfirm(po, e)}
                          disabled={confirmingId === po.id}
                          className="rounded px-1.5 py-px text-[9px] font-semibold bg-emerald-800/90 text-white hover:bg-emerald-700 disabled:opacity-40"
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
                        className="rounded-md p-1 text-slate-400 transition-colors hover:bg-red-950/50 hover:text-red-300 disabled:opacity-40 group-hover/po:text-amber-400"
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
      </div>

      {list.length === 0 ? (
        <p className="text-slate-500 text-center py-8 text-sm">No purchase orders found.</p>
      ) : viewRows.length === 0 ? (
        <p className="text-slate-500 text-center py-8 text-sm">
          No rows match this search. Clear the filter or refine your Cmd+K query.
        </p>
      ) : null}

      <SlideOverPanel
        title={drawerPo ? `PO ${drawerPo.poNumber}` : 'Purchase order'}
        isOpen={Boolean(drawerPoId)}
        onClose={() => setDrawerPoId(null)}
        widthClass="max-w-lg"
        backdropClassName="bg-black/55"
        panelClassName="border-l border-slate-700/80 bg-slate-950/92 backdrop-blur-xl shadow-2xl"
      >
        {drawerLoading || !drawerPo ? (
          <p className="text-slate-500 text-sm">Loading…</p>
        ) : (
          <div className="space-y-4 text-sm">
            <p className="text-[10px] text-slate-600 leading-snug">
              Default operator / metadata:{' '}
              <span className="text-slate-400 font-medium">{PO_DASHBOARD_OPERATOR}</span>
            </p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs text-slate-500">Customer</div>
                <div className="font-medium text-slate-100">{drawerPo.customer?.name}</div>
              </div>
              <div className={`text-right ${poMono} text-amber-200/90`}>
                <div className="text-[10px] text-slate-500 uppercase">Value</div>
                {formatRupee(drawerPo.value)}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                Tooling readiness
              </div>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800 ring-1 ring-slate-700/80">
                {toolingBar.total > 0 ? (
                  <>
                    <div
                      className="h-full bg-emerald-500 transition-[width]"
                      style={{ width: `${(toolingBar.g / toolingBar.total) * 100}%` }}
                    />
                    <div
                      className="h-full bg-amber-500 transition-[width]"
                      style={{ width: `${(toolingBar.y / toolingBar.total) * 100}%` }}
                    />
                    <div
                      className="h-full bg-rose-500 transition-[width]"
                      style={{ width: `${(toolingBar.r / toolingBar.total) * 100}%` }}
                    />
                  </>
                ) : (
                  <div className="h-full flex-1 bg-slate-700/50" />
                )}
              </div>
              <div className="mt-1 text-[10px] text-slate-500 tabular-nums">
                Green {toolingBar.g} · Yellow {toolingBar.y} · Red {toolingBar.r}{' '}
                <span className="text-slate-600">/ {toolingBar.total} lines</span>
              </div>
            </div>

            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                Line items
              </div>
              <div className="mb-2 grid grid-cols-[1fr_auto_auto] gap-x-2 text-[9px] font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-800 pb-1">
                <span>Carton</span>
                <span className="text-right">Qty</span>
                <span className="text-right">₹</span>
              </div>
              <ul className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
                {drawerPo.lineItems.map((li, i) => {
                  const tr = toolingResults?.find((t) => t.key === i)
                  const dot =
                    tr?.signal === 'green'
                      ? 'bg-emerald-500'
                      : tr?.signal === 'yellow'
                        ? 'bg-amber-500'
                        : 'bg-rose-500'
                  return (
                    <li
                      key={li.id}
                      className="rounded-md border border-slate-800/90 bg-slate-900/50 px-2 py-1.5 text-xs"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-1 h-2 w-2 shrink-0 rounded-full ring-2 ring-slate-950 ${dot}`}
                          title={tr?.tooltip}
                        />
                        <div className="min-w-0 flex-1 grid grid-cols-[1fr_auto_auto] gap-x-2 items-start">
                          <div className="font-medium text-slate-200 truncate">{li.cartonName}</div>
                          <span className={`${poMono} text-slate-300 text-[11px] text-right tabular-nums`}>
                            {li.quantity}
                          </span>
                          <span className={`${poMono} text-slate-200 text-[11px] text-right tabular-nums`}>
                            {li.rate != null
                              ? (Number(li.rate) * li.quantity).toLocaleString('en-IN', {
                                  maximumFractionDigits: 0,
                                })
                              : '—'}
                          </span>
                          <div className={`col-span-3 ${poMono} text-slate-500 text-[10px]`}>
                            {li.rate != null
                              ? `₹${Number(li.rate).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ea`
                              : ''}
                          </div>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className="space-y-2 border-t border-slate-800 pt-3">
              <label className="block text-[10px] uppercase tracking-wider text-slate-500">PO status</label>
              <select
                value={drawerPo.status}
                disabled={updatingId === drawerPo.id}
                onChange={(e) => handleStatusChange(drawerPo, e.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs text-white"
              >
                <option value="draft">draft</option>
                <option value="confirmed">confirmed</option>
                <option value="closed">closed</option>
              </select>
            </div>

            <Link
              href={`/orders/purchase-orders/${drawerPo.id}`}
              className="flex w-full items-center justify-center rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-amber-500 transition"
            >
              Go to Full Edit
            </Link>
          </div>
        )}
      </SlideOverPanel>
    </div>
  )
}
