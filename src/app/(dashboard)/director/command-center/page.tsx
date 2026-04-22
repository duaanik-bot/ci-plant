'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Star, PauseCircle, PlayCircle } from 'lucide-react'
import type { BarPart, DirectorLifeBars } from '@/lib/director-command-center-lifecycle'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { DirectorWorkspaceSidebar } from '@/components/director/DirectorWorkspaceSidebar'
import { broadcastIndustrialPriorityChange } from '@/lib/industrial-priority-sync'

const mono = 'font-director-cc tabular-nums tracking-tight'

type BusinessVitals = {
  sales: {
    liveOrderBookValue: number
    revenueDispatchedMtdValue: number
    gatePassDispatchesMtd: number
    gatePassUnitsMtd: number
    revenueTrend30d: { day: string; value: number }[]
  }
  procurement: {
    openMaterialSpend: number
    incomingBoardKg7d: number
  }
  production: {
    factoryOeePct: number
    lateOrdersPastDue: number
  }
  stageDistribution: {
    artworks: number
    tooling: number
    material: number
    production: number
    dispatch: number
  }
  alerts: {
    id: string
    severity: 'critical' | 'warning' | 'info'
    title: string
    detail: string
  }[]
}

type Metrics = {
  totalWipValue: number
  priorityJobs: number
  systemBottlenecks: number
  velocityDaysAvg30d: number
  velocitySampleCount: number
}

type GridRow = {
  id: string
  cartonId: string | null
  dieMasterId: string | null
  cartonName: string
  quantity: number
  rate: number | null
  lineValue: number
  directorPriority: boolean
  directorHold: boolean
  directorBroadcastNote: string | null
  directorCurrentStageKey: string | null
  stageKeyDerived: string
  ageDaysSincePoReceipt: number
  lifeBars: DirectorLifeBars
  po: {
    id: string
    poNumber: string
    status: string
    poDate: string
    customer: { id: string; name: string }
  }
  jobCardNumber: number | null
  artworkCode: string | null
  fileUrl: string | null
}

function formatRupee(n: number) {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

function MicroBar({ parts }: { parts: BarPart[] }) {
  const total = parts.reduce((s, p) => s + p.n, 0)
  return (
    <div className="h-1 w-full overflow-hidden rounded-sm bg-ds-card ring-1 ring-ds-line/40">
      {total === 0 ? (
        <div className="h-full w-full bg-ds-elevated" />
      ) : (
        <div className="flex h-full w-full">
          {parts.map((p, j) =>
            p.n > 0 ? (
              <div key={j} className={`h-full ${p.c}`} style={{ width: `${(p.n / total) * 100}%` }} />
            ) : null,
          )}
        </div>
      )}
    </div>
  )
}

function RevenueSparkline({ series }: { series: { day: string; value: number }[] }) {
  const w = 320
  const h = 52
  const pad = 4
  if (!series.length) {
    return <div className={`h-[52px] rounded bg-ds-main ring-1 ring-ring/30 ${mono} text-[10px] text-ds-ink-faint flex items-center justify-center`}>No data</div>
  }
  const vals = series.map((d) => d.value)
  const max = Math.max(...vals, 1)
  const min = 0
  const span = Math.max(max - min, 1)
  const step = series.length > 1 ? (w - 2 * pad) / (series.length - 1) : 0
  const points = series.map((d, i) => {
    const x = pad + i * step
    const y = pad + (1 - (d.value - min) / span) * (h - 2 * pad)
    return { x, y }
  })
  const dPath = points
    .map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`))
    .join(' ')
  const last = points[points.length - 1]
  const areaD =
    points.length > 0
      ? `${dPath} L ${last.x} ${h - pad} L ${points[0].x} ${h - pad} Z`
      : ''
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-[52px] text-ds-warning"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="revSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(251 191 36)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="rgb(251 191 36)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {areaD ? <path d={areaD} fill="url(#revSparkFill)" /> : null}
      {dPath ? (
        <path d={dPath} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      ) : null}
      <circle cx={last.x} cy={last.y} r="2.5" fill="rgb(251 191 36)" />
    </svg>
  )
}

function StageDistributionStack({
  dist,
}: {
  dist: BusinessVitals['stageDistribution']
}) {
  const parts = [
    { key: 'artworks' as const, n: dist.artworks, c: 'bg-violet-500', label: 'Artworks' },
    { key: 'tooling' as const, n: dist.tooling, c: 'bg-ds-line/40', label: 'Tooling' },
    { key: 'material' as const, n: dist.material, c: 'bg-sky-500', label: 'Material' },
    { key: 'production' as const, n: dist.production, c: 'bg-emerald-500', label: 'Production' },
    { key: 'dispatch' as const, n: dist.dispatch, c: 'bg-ds-warning', label: 'Dispatch' },
  ]
  const total = parts.reduce((s, p) => s + p.n, 0)
  return (
    <div>
      <div className="flex h-5 w-full overflow-hidden rounded-sm ring-1 ring-ring/40 bg-ds-main">
        {total === 0 ? (
          <div className="h-full flex-1 bg-ds-card" title="No open pipeline sample" />
        ) : (
          parts.map((p) =>
            p.n > 0 ? (
              <div
                key={p.key}
                className={`h-full ${p.c} min-w-[2px]`}
                style={{ width: `${(p.n / total) * 100}%` }}
                title={`${p.label}: ${p.n}`}
              />
            ) : null,
          )
        )}
      </div>
      <div className={`mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-ds-ink-faint ${mono}`}>
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1">
            <span className={`inline-block h-2 w-2 shrink-0 rounded-sm ${p.c}`} />
            {p.label}{' '}
            <span className="text-ds-ink-muted">{p.n.toLocaleString('en-IN')}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function FiveStageBar({ bars }: { bars: DirectorLifeBars }) {
  const cols: { key: keyof DirectorLifeBars; label: string }[] = [
    { key: 'artworks', label: 'Art' },
    { key: 'tooling', label: 'Tool' },
    { key: 'material', label: 'Mat' },
    { key: 'production', label: 'Prod' },
    { key: 'logistics', label: 'Log' },
  ]
  return (
    <div className="flex gap-1 min-w-[11rem]">
      {cols.map(({ key, label }) => (
        <div key={key} className="min-w-0 flex-1" title={label}>
          <div className="text-[6px] uppercase text-ds-ink-faint text-center mb-px">{label}</div>
          <MicroBar parts={bars[key]} />
        </div>
      ))}
    </div>
  )
}

export default function DirectorCommandCenterPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [vitals, setVitals] = useState<BusinessVitals | null>(null)
  const [rows, setRows] = useState<GridRow[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [drawerDetail, setDrawerDetail] = useState<unknown>(null)
  const [drawerAudit, setDrawerAudit] = useState<
    { id: string; timestamp: string; newValue: unknown }[]
  >([])
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [focusedLineId, setFocusedLineId] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [mRes, lRes, vRes] = await Promise.all([
        fetch('/api/director-command-center/metrics'),
        fetch('/api/director-command-center/lines'),
        fetch('/api/director-command-center/business-vitals'),
      ])
      const m = await mRes.json()
      const l = await lRes.json()
      const v = await vRes.json().catch(() => null)
      if (mRes.ok) setMetrics(m as Metrics)
      if (vRes.ok && v && typeof v === 'object') setVitals(v as BusinessVitals)
      if (lRes.ok && Array.isArray(l)) {
        setRows(l as GridRow[])
        const nd: Record<string, string> = {}
        for (const r of l as GridRow[]) {
          nd[r.id] = r.directorBroadcastNote ?? ''
        }
        setNoteDraft(nd)
      }
    } catch {
      toast.error('Failed to load Command Center')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    if (!drawerId) {
      setDrawerDetail(null)
      setDrawerAudit([])
      return
    }
    let cancelled = false
    setDrawerLoading(true)
    void (async () => {
      try {
        const [dRes, aRes] = await Promise.all([
          fetch(`/api/designing/po-lines/${drawerId}`),
          fetch(`/api/director-command-center/lines/${drawerId}/audit`),
        ])
        const d = await dRes.json()
        const a = await aRes.json()
        if (!cancelled) {
          if (dRes.ok) setDrawerDetail(d)
          if (aRes.ok && Array.isArray(a)) setDrawerAudit(a)
        }
      } catch {
        if (!cancelled) toast.error('Failed to load drawer')
      } finally {
        if (!cancelled) setDrawerLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [drawerId])

  async function patchLine(id: string, body: Record<string, unknown>) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/director-command-center/lines/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((j as { error?: string }).error || 'Update failed')
      if (Object.prototype.hasOwnProperty.call(body, 'directorPriority')) {
        broadcastIndustrialPriorityChange({
          source: 'line_director_priority',
          at: new Date().toISOString(),
        })
      }
      await loadAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusyId(null)
    }
  }

  const vitalsLoading = loading && !vitals
  const alerts = vitals?.alerts ?? []

  return (
    <div className="min-h-screen bg-background text-ds-ink flex">
      <DirectorWorkspaceSidebar
        rows={rows}
        focusedLineId={focusedLineId}
        onFocusLine={setFocusedLineId}
        monoClass={mono}
      />
      <div className="min-w-0 flex-1 p-3 md:p-4 max-w-[1800px] mx-auto space-y-3 pb-24">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-lg md:text-xl font-bold text-ds-warning tracking-tight">
              Director Command Center
            </h1>
            <p className="text-[11px] text-ds-ink-faint">
              Business vitals · pipeline · priority overrides (audit logged)
            </p>
            <p className="mt-1 text-[10px] text-ds-ink-faint">
              <kbd className="rounded border border-ds-line/50 bg-ds-main px-1 py-px font-director-cc text-ds-ink-muted">
                ⌘K
              </kbd>{' '}
              /{' '}
              <kbd className="rounded border border-ds-line/50 bg-ds-main px-1 py-px font-director-cc text-ds-ink-muted">
                Ctrl+K
              </kbd>{' '}
              — search KPIs, vendors, and customer records from anywhere in the app.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <Link
              href="/orders/designing"
              className="px-3 py-1.5 rounded-lg border border-ds-line/50 text-ds-ink hover:border-ds-line/50"
            >
              Artwork queue
            </Link>
            <Link
              href="/orders/planning"
              className="px-3 py-1.5 rounded-lg border border-ds-line/50 text-ds-ink hover:border-ds-line/50"
            >
              Planning
            </Link>
            <Link
              href="/orders/procurement"
              className="px-3 py-1.5 rounded-lg border border-sky-600/50 text-sky-200 hover:bg-sky-950/50"
            >
              Procurement
            </Link>
            <Link
              href="/orders/purchase-orders"
              className="px-3 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground font-semibold"
            >
              Customer POs
            </Link>
          </div>
        </div>

        <section aria-label="Business vitals" className="grid gap-3 lg:grid-cols-3">
          <div className="rounded-xl border border-ds-warning/30 bg-card p-3 shadow-[inset_0_1px_0_0_rgba(251,191,36,0.12)]">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-ds-warning/95">
              Zone 1 · Sales
            </h2>
            <div className="mt-2 grid gap-2">
              <div className="rounded-lg border border-ds-warning/20 bg-ds-main/80 px-3 py-2">
                <div className="text-[9px] font-semibold uppercase text-ds-warning/80">
                  Live order book
                </div>
                <div className={`text-base font-semibold text-ds-ink ${mono}`}>
                  {vitalsLoading ? '—' : formatRupee(vitals?.sales.liveOrderBookValue ?? 0)}
                </div>
                <div className="text-[9px] text-ds-ink-faint">Active customer PO lines (draft + confirmed)</div>
              </div>
              <div className="rounded-lg border border-ds-warning/20 bg-ds-main/80 px-3 py-2">
                <div className="text-[9px] font-semibold uppercase text-ds-warning/80">
                  Revenue dispatched (MTD)
                </div>
                <div className={`text-base font-semibold text-ds-ink ${mono}`}>
                  {vitalsLoading
                    ? '—'
                    : formatRupee(vitals?.sales.revenueDispatchedMtdValue ?? 0)}
                </div>
                <div className="text-[9px] text-ds-ink-faint">
                  Closed PO ₹ this month (until gate passes carry ₹). Gate passes MTD:{' '}
                  <span className={mono}>
                    {vitalsLoading
                      ? '—'
                      : (vitals?.sales.gatePassDispatchesMtd ?? 0).toLocaleString('en-IN')}{' '}
                    docs ·{' '}
                    {(vitals?.sales.gatePassUnitsMtd ?? 0).toLocaleString('en-IN')} units
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-sky-500/40 bg-card p-3 shadow-[inset_0_1px_0_0_rgba(56,189,248,0.12)]">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-sky-300">
              Zone 2 · Procurement
            </h2>
            <div className="mt-2 grid gap-2">
              <div className="rounded-lg border border-sky-500/25 bg-ds-main/80 px-3 py-2">
                <div className="text-[9px] font-semibold uppercase text-sky-400/90">
                  Open material spend
                </div>
                <div className={`text-base font-semibold text-sky-100 ${mono}`}>
                  {vitalsLoading ? '—' : formatRupee(vitals?.procurement.openMaterialSpend ?? 0)}
                </div>
                <div className="text-[9px] text-ds-ink-faint">Open vendor material POs (₹ est.)</div>
              </div>
              <div className="rounded-lg border border-sky-500/25 bg-ds-main/80 px-3 py-2">
                <div className="text-[9px] font-semibold uppercase text-sky-400/90">
                  Incoming tonnage (7d)
                </div>
                <div className={`text-base font-semibold text-sky-100 ${mono}`}>
                  {vitalsLoading
                    ? '—'
                    : `${((vitals?.procurement.incomingBoardKg7d ?? 0) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} t`}
                </div>
                <div className={`text-[9px] text-ds-ink-faint ${mono}`}>
                  {(vitals?.procurement.incomingBoardKg7d ?? 0).toLocaleString('en-IN', {
                    maximumFractionDigits: 0,
                  })}{' '}
                  kg board · required delivery within 7 days
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-emerald-500/40 bg-card p-3 shadow-[inset_0_1px_0_0_rgba(52,211,153,0.12)]">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-emerald-300">
              Zone 3 · Production
            </h2>
            <div className="mt-2 grid gap-2">
              <div className="rounded-lg border border-emerald-500/25 bg-ds-main/80 px-3 py-2">
                <div className="text-[9px] font-semibold uppercase text-emerald-400/90">
                  Factory OEE
                </div>
                <div className={`text-base font-semibold text-emerald-100 ${mono}`}>
                  {vitalsLoading
                    ? '—'
                    : `${(vitals?.production.factoryOeePct ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`}
                </div>
                <div className="text-[9px] text-ds-ink-faint">CI-01 · CI-02 · CI-03 average (today)</div>
              </div>
              <div className="rounded-lg border border-emerald-500/25 bg-ds-main/80 px-3 py-2">
                <div className="text-[9px] font-semibold uppercase text-emerald-400/90">
                  Late order alert
                </div>
                <div className={`text-base font-semibold text-emerald-100 ${mono}`}>
                  {vitalsLoading
                    ? '—'
                    : (vitals?.production.lateOrdersPastDue ?? 0).toLocaleString('en-IN')}
                </div>
                <div className="text-[9px] text-ds-ink-faint">Customer POs past &quot;delivery required by&quot;</div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/40 bg-card px-3 py-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
              Revenue trend (30 days)
            </div>
            <p className="mt-0.5 text-[9px] text-ds-ink-faint">
              Sales volume (₹) from customer POs closed each day — sparkline for directional view.
            </p>
            <div className="mt-2">
              <RevenueSparkline series={vitals?.sales.revenueTrend30d ?? []} />
            </div>
          </div>
          <div className="rounded-xl border border-border/40 bg-card px-3 py-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
              Stage distribution
            </div>
            <p className="mt-0.5 text-[9px] text-ds-ink-faint">
              Job volume by pipeline stage (sample of open lines).
            </p>
            <div className="mt-3">
              <StageDistributionStack
                dist={
                  vitals?.stageDistribution ?? {
                    artworks: 0,
                    tooling: 0,
                    material: 0,
                    production: 0,
                    dispatch: 0,
                  }
                }
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="rounded-xl border border-border/40 bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase text-ds-ink-faint">Total WIP value</div>
            <div className={`text-lg font-semibold text-emerald-300 ${mono}`}>
              {loading ? '—' : formatRupee(metrics?.totalWipValue ?? 0)}
            </div>
            <div className="text-[9px] text-ds-ink-faint">Tooling · Material · Printing</div>
          </div>
          <div className="rounded-xl border border-ds-warning/25 bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase text-ds-warning/80">Priority jobs</div>
            <div className={`text-lg font-semibold text-ds-warning ${mono}`}>
              {loading ? '—' : (metrics?.priorityJobs ?? 0).toLocaleString('en-IN')}
            </div>
            <div className="text-[9px] text-ds-ink-faint">Director star</div>
          </div>
          <div className="rounded-xl border border-rose-500/25 bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase text-rose-400/90">Bottlenecks</div>
            <div className={`text-lg font-semibold text-rose-200 ${mono}`}>
              {loading ? '—' : (metrics?.systemBottlenecks ?? 0).toLocaleString('en-IN')}
            </div>
            <div className="text-[9px] text-ds-ink-faint">&gt; 48h in stage</div>
          </div>
          <div className="rounded-xl border border-sky-500/25 bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase text-sky-400/90">Velocity</div>
            <div className={`text-lg font-semibold text-sky-200 ${mono}`}>
              {loading
                ? '—'
                : `${(metrics?.velocityDaysAvg30d ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} d`}
            </div>
            <div className="text-[9px] text-ds-ink-faint">
              PO → dispatch · 30d · n={metrics?.velocitySampleCount ?? 0}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
          <div className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-ds-line/40 bg-card">
            <table className="w-full min-w-[1100px] border-collapse text-left text-[10px]">
              <thead className="sticky top-0 z-30 border-b border-ds-line/40 bg-card text-ds-ink-faint backdrop-blur-md">
            <tr>
              <th className="px-1 py-1 w-8">★</th>
              <th className="px-1 py-1 w-10">Hold</th>
              <th className="px-1 py-1">Product / PO</th>
              <th className="px-1 py-1">Lifecycle</th>
              <th className={`px-1 py-1 text-right ${mono}`}>₹</th>
              <th className={`px-1 py-1 text-right ${mono}`}>Age</th>
              <th className="px-1 py-1 min-w-[8rem]">Broadcast</th>
            </tr>
              </thead>
              <tbody className="bg-card text-ds-ink">
            {rows.map((r) => {
              const ageCls =
                r.ageDaysSincePoReceipt > 7
                  ? 'text-rose-400 animate-po-age-alert'
                  : r.ageDaysSincePoReceipt > 3
                    ? 'text-ds-warning'
                    : 'text-emerald-400'
              return (
                <tr
                  key={r.id}
                  data-director-line={r.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setFocusedLineId(r.id)
                    setDrawerId(r.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setFocusedLineId(r.id)
                      setDrawerId(r.id)
                    }
                  }}
                  className={`border-b border-ds-card hover:bg-ds-main/80 cursor-pointer transition-[box-shadow] duration-200 ease-in-out ${
                    r.directorHold ? 'opacity-45' : ''
                  } ${
                    focusedLineId === r.id
                      ? 'bg-[#f97316]/[0.06] shadow-[inset_3px_0_0_0_#f97316]'
                      : ''
                  }`}
                >
                  <td className="px-1 py-0.5 align-middle" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      aria-pressed={r.directorPriority}
                      onClick={() =>
                        void patchLine(r.id, { directorPriority: !r.directorPriority })
                      }
                      className="p-0.5 rounded text-ds-ink-faint hover:bg-ds-card disabled:opacity-40"
                    >
                      <Star
                        className={`h-3.5 w-3.5 ${
                          r.directorPriority
                            ? 'fill-ds-warning text-ds-warning drop-shadow-[0_0_6px_rgba(251,191,36,0.5)]'
                            : ''
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-1 py-0.5 align-middle" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      title={r.directorHold ? 'Release hold' : 'Hold line'}
                      onClick={() => void patchLine(r.id, { directorHold: !r.directorHold })}
                      className="p-0.5 rounded text-ds-ink-faint hover:text-ds-warning hover:bg-ds-card disabled:opacity-40"
                    >
                      {r.directorHold ? (
                        <PauseCircle className="h-4 w-4 text-ds-warning/90" />
                      ) : (
                        <PlayCircle className="h-4 w-4" />
                      )}
                    </button>
                  </td>
                  <td className="px-1 py-0.5 align-top">
                    <div className={`font-semibold text-ds-ink ${mono}`}>{r.cartonName}</div>
                    <div className="text-ds-ink-faint">
                      <span className={mono}>{r.po.poNumber}</span> · {r.po.customer.name}
                    </div>
                    <div className="text-[9px] text-ds-ink-faint">
                      Stage: {r.stageKeyDerived}
                      {r.directorPriority ? (
                        <span className="ml-1 text-ds-warning font-bold">DIRECTOR PRIORITY</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-1 py-0.5 align-middle">
                    <FiveStageBar bars={r.lifeBars} />
                  </td>
                  <td className={`px-1 py-0.5 align-middle text-right ${mono} text-ds-ink`}>
                    {formatRupee(r.lineValue)}
                  </td>
                  <td className={`px-1 py-0.5 align-middle text-right ${mono} font-medium ${ageCls}`}>
                    {r.ageDaysSincePoReceipt}d
                  </td>
                  <td className="px-1 py-0.5 align-top" onClick={(e) => e.stopPropagation()}>
                    <textarea
                      rows={2}
                      value={noteDraft[r.id] ?? ''}
                      onChange={(e) =>
                        setNoteDraft((prev) => ({ ...prev, [r.id]: e.target.value }))
                      }
                      onBlur={() => {
                        const next = (noteDraft[r.id] ?? '').trim()
                        const prev = (r.directorBroadcastNote ?? '').trim()
                        if (next === prev) return
                        void patchLine(r.id, { directorBroadcastNote: next || null })
                      }}
                      placeholder="Floor note…"
                      className="w-full min-w-[7rem] rounded border border-ds-line/40 bg-card px-1 py-0.5 text-[10px] text-ds-ink placeholder:text-neutral-700 focus:border-ds-warning/50 focus:outline-none"
                    />
                  </td>
                </tr>
              )
            })}
              </tbody>
            </table>
          </div>

          <aside
            className="w-full shrink-0 space-y-2 xl:sticky xl:top-3 xl:w-80 xl:self-start"
            aria-label="Director action feed"
          >
            <div className="rounded-xl border border-rose-500/30 bg-card px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-rose-300">
                Alert center
              </div>
              <p className="text-[9px] text-ds-ink-faint">Critical issues for review.</p>
            </div>
            <div className="max-h-[min(70vh,520px)] space-y-2 overflow-y-auto rounded-xl border border-border/40 bg-card p-2">
              {vitalsLoading ? (
                <p className={`px-2 py-4 text-center text-[11px] text-ds-ink-faint ${mono}`}>Loading alerts…</p>
              ) : alerts.length === 0 ? (
                <p className={`px-2 py-4 text-center text-[11px] text-ds-ink-faint ${mono}`}>
                  No critical alerts.
                </p>
              ) : (
                alerts.map((a) => {
                  const border =
                    a.severity === 'critical'
                      ? 'border-rose-500/45 bg-rose-950/20'
                      : a.severity === 'warning'
                        ? 'border-ds-warning/30 bg-ds-warning/8'
                        : 'border-ds-line/60 bg-ds-main/50'
                  return (
                    <div
                      key={a.id}
                      className={`rounded-lg border px-2.5 py-2 text-[11px] leading-snug ${border}`}
                    >
                      <div className="font-semibold text-ds-ink">{a.title}</div>
                      <div className={`mt-1 text-ds-ink-faint ${mono}`}>{a.detail}</div>
                    </div>
                  )
                })
              )}
            </div>
          </aside>
        </div>

        {rows.length === 0 && !loading ? (
          <p className="py-6 text-center text-sm text-ds-ink-faint">No active pipeline lines.</p>
        ) : null}

        <SlideOverPanel
        title="Product detail"
        isOpen={Boolean(drawerId)}
        onClose={() => setDrawerId(null)}
        widthClass="max-w-lg"
        backdropClassName="bg-background/60"
        panelClassName="border-l border-ds-line/40 bg-ds-main/95 backdrop-blur-xl"
      >
        {drawerLoading || !drawerDetail ? (
          <p className="text-ds-ink-faint text-sm">Loading…</p>
        ) : (
          <DrawerBody detail={drawerDetail} audit={drawerAudit} mono={mono} />
        )}
        </SlideOverPanel>
      </div>
    </div>
  )
}

function DrawerBody({
  detail,
  audit,
  mono,
}: {
  detail: unknown
  audit: { id: string; timestamp: string; newValue: unknown }[]
  mono: string
}) {
  const d = detail as {
    line?: Record<string, unknown>
    jobCard?: { fileUrl?: string | null; jobCardNumber?: number; status?: string } | null
    checks?: Record<string, boolean>
    links?: Record<string, string | null>
  }
  const line = d.line
  const spec =
    line?.specOverrides && typeof line.specOverrides === 'object'
      ? (line.specOverrides as Record<string, unknown>)
      : {}
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="text-xs text-ds-ink-faint">Carton</div>
        <div className="font-medium text-foreground">{String(line?.cartonName ?? '')}</div>
      </div>
      <div className={`grid grid-cols-2 gap-2 text-xs ${mono}`}>
        <div>
          <span className="text-ds-ink-faint">Qty</span> {String(line?.quantity ?? '')}
        </div>
        <div>
          <span className="text-ds-ink-faint">GSM</span> {String(line?.gsm ?? '—')}
        </div>
        <div className="col-span-2">
          <span className="text-ds-ink-faint">Paper</span> {String(line?.paperType ?? '—')}
        </div>
        <div className="col-span-2">
          <span className="text-ds-ink-faint">Coating</span> {String(line?.coatingType ?? '—')}
        </div>
      </div>
      {d.jobCard?.fileUrl ? (
        <div>
          <div className="text-xs text-ds-ink-faint mb-1">Artwork / file</div>
          <a
            href={d.jobCard.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ds-warning hover:underline text-xs break-all"
          >
            {d.jobCard.fileUrl}
          </a>
        </div>
      ) : null}
      <div className="text-xs text-ds-ink-muted space-y-1">
        <div>
          <span className="text-ds-ink-faint">Dims (mm)</span> L {String(spec.dimLengthMm ?? line?.dimLengthMm ?? '—')}{' '}
          × W {String(spec.dimWidthMm ?? line?.dimWidthMm ?? '—')} × H{' '}
          {String(spec.dimHeightMm ?? line?.dimHeightMm ?? '—')}
        </div>
      </div>
      {d.links?.po ? (
        <Link
          href={d.links.po}
          className="inline-flex rounded-lg bg-ds-warning px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-ds-warning"
        >
          Open PO
        </Link>
      ) : null}

      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint mb-2">
          Command Center audit
        </div>
        <ul className="max-h-48 overflow-y-auto space-y-2 text-[11px] border-t border-ds-line/40 pt-2">
          {audit.length === 0 ? (
            <li className="text-ds-ink-faint">No director actions yet.</li>
          ) : (
            audit.map((a) => {
              const nv = a.newValue as { summary?: string } | null
              return (
                <li key={a.id} className="border-b border-ds-card pb-1">
                  <div className="text-ds-ink-faint text-[10px]">
                    {new Date(a.timestamp).toLocaleString('en-IN')}
                  </div>
                  <div className="text-ds-ink-muted">{nv?.summary ?? 'Update'}</div>
                </li>
              )
            })
          )}
        </ul>
      </div>
    </div>
  )
}
