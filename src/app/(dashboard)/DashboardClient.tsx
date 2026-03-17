'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import {
  Briefcase,
  Factory,
  Gauge,
  ClipboardCheck,
  Truck,
  Circle,
  CircleDot,
} from 'lucide-react'
import { WORKFLOW_STAGE_COUNT } from '@/lib/workflow'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from 'recharts'

type Stats = {
  activeJobs: number
  runningPresses: number
  avgOee: number
  pendingApprovals: number
  dispatchDue: number
}

type PressStatus = {
  machineCode: string
  machineName: string
  status: string
  job: { jobNumber: string; productName: string } | null
  oee: number
  sheets: number
  firstArticleStatus: string | null
}

type AlertItem = {
  type: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  description: string
  link: string
}

type PipelineJob = {
  id: string
  jobNumber: string
  productName: string
  customerName: string
  currentStageNumber: number | null
  currentStageName: string | null
  percentComplete: number
  dueDate: string
}

const STAT_CARDS: {
  key: keyof Stats
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  format: (v: number) => string
}[] = [
  { key: 'activeJobs', label: 'Active Jobs', href: '/jobs', icon: Briefcase, format: (v) => String(v) },
  { key: 'runningPresses', label: 'Running Presses', href: '/production/stages', icon: Factory, format: (v) => String(v) },
  { key: 'avgOee', label: 'OEE Today %', href: '/oee', icon: Gauge, format: (v) => `${v}%` },
  { key: 'pendingApprovals', label: 'Pending Approvals', href: '/stores/approve-excess', icon: ClipboardCheck, format: (v) => String(v) },
  { key: 'dispatchDue', label: 'Dispatch Due', href: '/billing', icon: Truck, format: (v) => String(v) },
]

const SHEETS_TARGET = 5000

const TREND_DATA = [
  { day: 'Mon', ci01: 12000, ci02: 9000, ci03: 7500 },
  { day: 'Tue', ci01: 14000, ci02: 10000, ci03: 8000 },
  { day: 'Wed', ci01: 11000, ci02: 8500, ci03: 7000 },
  { day: 'Thu', ci01: 15000, ci02: 11000, ci03: 9000 },
  { day: 'Fri', ci01: 13000, ci02: 9500, ci03: 8500 },
  { day: 'Sat', ci01: 8000, ci02: 6000, ci03: 5000 },
]

const WASTAGE_DATA = [
  { machine: 'CI-01', pct: 3.2 },
  { machine: 'CI-02', pct: 4.8 },
  { machine: 'CI-03', pct: 2.1 },
  { machine: 'CI-04', pct: 5.5 },
  { machine: 'CI-05', pct: 1.8 },
  { machine: 'CI-06', pct: 3.9 },
]

const RFQ_PIPELINE_STAGES = [
  { key: 'received', label: 'RFQ Received' },
  { key: 'feasibility', label: 'Feasibility' },
  { key: 'quoted', label: 'Quoted' },
  { key: 'po_received', label: 'PO Received' },
  { key: 'in_production', label: 'In Production' },
  { key: 'ready_dispatch', label: 'Ready Dispatch' },
] as const

function StatCardSkeleton() {
  return (
    <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 animate-pulse">
      <div className="h-6 w-6 rounded bg-slate-700 ml-auto mb-3" />
      <div className="h-9 w-16 bg-slate-700 rounded mb-2" />
      <div className="h-4 w-24 bg-slate-700 rounded" />
    </div>
  )
}

function dueDateClass(dueDate: string): string {
  const due = new Date(dueDate)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  due.setHours(0, 0, 0, 0)
  const diff = due.getTime() - today.getTime()
  if (diff < 0) return 'text-red-400'
  if (diff === 0) return 'text-amber-400'
  return 'text-white'
}

export function DashboardClient() {
  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ['dashboard-stats'],
    queryFn: () => fetch('/api/dashboard/stats').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const { data: presses, isLoading: pressesLoading } = useQuery<PressStatus[]>({
    queryKey: ['dashboard-press-status'],
    queryFn: () => fetch('/api/dashboard/press-status').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const { data: alerts } = useQuery<AlertItem[]>({
    queryKey: ['dashboard-alerts'],
    queryFn: () => fetch('/api/dashboard/alerts').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const { data: pipeline } = useQuery<PipelineJob[]>({
    queryKey: ['dashboard-active-jobs'],
    queryFn: () => fetch('/api/dashboard/active-jobs-pipeline').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const { data: rfqList } = useQuery<{ id: string; status: string }[]>({
    queryKey: ['dashboard-rfq'],
    queryFn: () => fetch('/api/rfq').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const { data: stockAlerts } = useQuery<
    { materialCode: string; description: string; qtyAvailable: number; reorderPoint: number }[]
  >({
    queryKey: ['dashboard-inventory-alerts'],
    queryFn: () => fetch('/api/inventory/alerts').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const { data: jobsList } = useQuery<
    {
      id: string
      jobNumber: string
      productName: string
      qtyOrdered: number
      dueDate: string
      status: string
      artwork?: { locksCompleted?: number } | null
    }[]
  >({
    queryKey: ['dashboard-jobs'],
    queryFn: () => fetch('/api/jobs').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const { data: openNcrs } = useQuery<
    { id: string; severity: string }[]
  >({
    queryKey: ['dashboard-ncrs-open'],
    queryFn: () => fetch('/api/ncrs?status=open').then((r) => r.json()),
    refetchInterval: 30000,
  })

  const rfqCountByStatus = (() => {
    const counts: Record<string, number> = {}
    RFQ_PIPELINE_STAGES.forEach((s) => { counts[s.key] = 0 })
    ;(rfqList || []).forEach((r) => {
      counts[r.status] = (counts[r.status] ?? 0) + 1
    })
    return counts
  })()

  const dispatchThisWeek = (() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const endOfWeek = new Date(today)
    endOfWeek.setDate(today.getDate() + 7)
    return (jobsList || [])
      .filter(
        (j) =>
          (j.status === 'final_qc' || j.status === 'packing') &&
          new Date(j.dueDate) <= endOfWeek &&
          new Date(j.dueDate) >= today
      )
      .slice(0, 5)
  })()

  const ncrCountBySeverity = (() => {
    const list = openNcrs || []
    return {
      critical: list.filter((n) => n.severity === 'critical').length,
      major: list.filter((n) => n.severity === 'major').length,
      minor: list.filter((n) => n.severity === 'minor').length,
    }
  })()

  return (
    <div className="min-h-screen bg-[#0F172A] text-white w-full p-4 md:p-6">
      {/* ROW 1 — STAT BAR */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {STAT_CARDS.map((card) => {
          const Icon = card.icon
          const value = stats ? stats[card.key] : 0
          const display = typeof value === 'number' && card.key === 'avgOee' ? card.format(value) : card.format(Number(value))

          if (statsLoading) {
            return <StatCardSkeleton key={card.key} />
          }

          return (
            <Link
              key={card.key}
              href={card.href}
              className="bg-slate-800 rounded-xl p-5 border border-slate-700 cursor-pointer hover:border-blue-500 transition-colors flex flex-col relative"
            >
              <div className="absolute top-4 right-4 text-slate-500">
                <Icon className="h-6 w-6" />
              </div>
              <span className="text-3xl font-bold text-white mt-2">{display}</span>
              <span className="text-sm text-slate-400 mt-1">{card.label}</span>
            </Link>
          )
        })}
      </div>

      {/* ROW 2 — THREE COLUMNS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* LEFT — Press Status — Live */}
        <div className="rounded-xl bg-slate-800 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Press Status — Live</h2>
          {pressesLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 animate-pulse">
                  <div className="h-4 w-16 bg-slate-700 rounded mb-2" />
                  <div className="h-3 w-full bg-slate-700 rounded" />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {(presses || []).map((p) => {
                const borderColor =
                  p.status === 'active'
                    ? 'border-l-green-500'
                    : p.status === 'under_maintenance'
                    ? 'border-l-red-500'
                    : 'border-l-slate-500'
                const dotColor =
                  p.status === 'active'
                    ? 'bg-green-500'
                    : p.status === 'under_maintenance'
                    ? 'bg-red-500'
                    : 'bg-slate-500'
                const barPct = Math.min(100, (p.sheets / SHEETS_TARGET) * 100)

                return (
                  <div
                    key={p.machineCode}
                    className={`rounded-lg border border-slate-700 border-l-4 ${borderColor} bg-slate-800/60 p-3 space-y-2`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-amber-300">{p.machineCode}</span>
                      <span className={`h-2 w-2 rounded-full ${dotColor}`} title={p.status} />
                    </div>
                    <p className="text-xs text-slate-300 truncate">
                      {p.job
                        ? `${p.job.jobNumber} — ${p.job.productName}`
                        : 'No active job — Idle'}
                    </p>
                    <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
                      <div
                        className="h-full bg-amber-500 rounded-full"
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">
                        Sheets: {p.sheets.toLocaleString()} / {SHEETS_TARGET.toLocaleString()}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-200">
                        OEE {p.oee.toFixed(1)}%
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">
                      Artwork: {p.firstArticleStatus ? '✅' : '🔒'}
                    </p>
                  </div>
                )
              })}
              {(!presses || presses.length === 0) && (
                <p className="text-xs text-slate-500">No press data.</p>
              )}
            </div>
          )}
        </div>

        {/* MIDDLE — Active Jobs Pipeline */}
        <div className="rounded-xl bg-slate-800 border border-slate-700 p-4 flex flex-col">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Active Jobs Pipeline</h2>
          <div className="space-y-2 overflow-y-auto max-h-80">
            {(pipeline || []).length === 0 && (
              <p className="text-xs text-slate-500">No active jobs</p>
            )}
            {(pipeline || []).map((job) => {
              const filled = Math.round((job.percentComplete / 100) * WORKFLOW_STAGE_COUNT)
              const dueStr = new Date(job.dueDate).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })

              return (
                <Link
                  key={job.id}
                  href={`/workflow/${job.id}`}
                  className="block rounded-lg bg-slate-800/60 border border-slate-700 px-3 py-2 hover:border-blue-500/60 transition-colors"
                >
                  <div className="flex justify-between text-xs">
                    <span className="font-mono text-amber-300">{job.jobNumber}</span>
                    <span className="text-slate-500 truncate max-w-[100px]">{job.customerName}</span>
                  </div>
                  <p className="text-xs text-slate-300 truncate mt-0.5">{job.productName}</p>
                  <div className="flex items-center gap-0.5 mt-1.5 flex-wrap">
                    {Array.from({ length: WORKFLOW_STAGE_COUNT }, (_, i) =>
                      i < filled ? (
                        <CircleDot key={i} className="h-2.5 w-2.5 text-blue-400 fill-blue-400" />
                      ) : (
                        <Circle key={i} className="h-2.5 w-2.5 text-slate-600" />
                      )
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Stage {job.currentStageNumber ?? '—'}/{WORKFLOW_STAGE_COUNT}
                    {job.currentStageName ? ` · ${job.currentStageName}` : ''}
                  </p>
                  <p className={`text-xs mt-1 font-medium ${dueDateClass(job.dueDate)}`}>
                    Due: {dueStr}
                  </p>
                </Link>
              )
            })}
          </div>
        </div>

        {/* RIGHT — Action Required */}
        <div className="rounded-xl bg-slate-800 border border-slate-700 p-4 flex flex-col">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Action Required</h2>
          <div className="space-y-1 overflow-y-auto max-h-80">
            {(alerts || []).length === 0 && (
              <p className="text-xs text-slate-500">No alerts.</p>
            )}
            {(alerts || []).map((a, idx) => {
              const barColor =
                a.severity === 'critical'
                  ? 'border-l-red-500'
                  : a.severity === 'warning'
                  ? 'border-l-amber-500'
                  : 'border-l-blue-500'

              return (
                <Link
                  key={idx}
                  href={a.link}
                  className={`block rounded-r border border-slate-700 border-l-4 ${barColor} pl-3 py-2 pr-2 hover:bg-slate-700/50 transition-colors`}
                >
                  <p
                    className={`text-xs font-semibold ${
                      a.severity === 'critical'
                        ? 'text-red-400'
                        : a.severity === 'warning'
                        ? 'text-amber-400'
                        : 'text-slate-200'
                    }`}
                  >
                    {a.title}
                  </p>
                  <p className="text-[11px] text-slate-400 truncate mt-0.5">{a.description}</p>
                </Link>
              )
            })}
          </div>
        </div>
      </div>

      {/* ROW 3 — Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
        <div className="lg:col-span-3 rounded-xl bg-slate-800 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Impressions This Week</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={TREND_DATA}>
              <XAxis dataKey="day" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
                labelStyle={{ color: '#e2e8f0' }}
              />
              <Legend />
              <Line type="monotone" dataKey="ci01" name="CI-01" stroke="#3B82F6" strokeWidth={2} dot={{ fill: '#3B82F6' }} />
              <Line type="monotone" dataKey="ci02" name="CI-02" stroke="#14B8A6" strokeWidth={2} dot={{ fill: '#14B8A6' }} />
              <Line type="monotone" dataKey="ci03" name="CI-03" stroke="#F97316" strokeWidth={2} dot={{ fill: '#F97316' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="lg:col-span-2 rounded-xl bg-slate-800 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Wastage % This Month</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={WASTAGE_DATA} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <XAxis dataKey="machine" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
                labelStyle={{ color: '#e2e8f0' }}
              />
              <ReferenceLine y={5} stroke="#EF4444" strokeDasharray="3 3" />
              <Bar dataKey="pct" name="Wastage %" radius={[4, 4, 0, 0]}>
                {WASTAGE_DATA.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={
                      entry.pct <= 3
                        ? '#22C55E'
                        : entry.pct <= 5
                        ? '#F59E0B'
                        : '#EF4444'
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ROW 4 — RFQ Pipeline */}
      <div className="rounded-xl bg-slate-800 border border-slate-700 p-4 mb-6">
        <h2 className="text-sm font-semibold text-slate-200 mb-3">RFQ Pipeline</h2>
        <div className="flex flex-wrap items-center gap-2">
          {RFQ_PIPELINE_STAGES.map((stage, idx) => (
            <span key={stage.key} className="flex items-center gap-2">
              <Link
                href={`/rfq?status=${stage.key}`}
                className="bg-slate-700 rounded-lg px-4 py-3 text-center hover:bg-slate-600 transition-colors min-w-[100px]"
              >
                <span className="block text-xl font-bold text-white">
                  {rfqCountByStatus[stage.key] ?? 0}
                </span>
                <span className="block text-xs text-slate-400 mt-0.5">{stage.label}</span>
              </Link>
              {idx < RFQ_PIPELINE_STAGES.length - 1 && (
                <span className="text-slate-500">→</span>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* ROW 5 — Three columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl bg-slate-800 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Stock Alerts</h2>
          <div className="space-y-2 overflow-y-auto max-h-48">
            {(stockAlerts || []).length === 0 ? (
              <p className="text-sm text-green-400">All stock levels normal ✓</p>
            ) : (
              (stockAlerts || []).map((item) => {
                const available = Number(item.qtyAvailable)
                const reorder = Number(item.reorderPoint)
                const critical = available <= 0
                return (
                  <div
                    key={item.materialCode}
                    className="flex justify-between items-center text-sm gap-2"
                  >
                    <span className="text-white truncate flex-1">{item.description || item.materialCode}</span>
                    <span className="text-slate-400 shrink-0">
                      {available.toLocaleString()} / {reorder.toLocaleString()}
                    </span>
                    <span
                      className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${
                        critical ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'
                      }`}
                    >
                      {critical ? 'Critical' : 'Warning'}
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
        <div className="rounded-xl bg-slate-800 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Dispatch This Week</h2>
          <div className="space-y-2 overflow-y-auto max-h-48">
            {dispatchThisWeek.length === 0 ? (
              <p className="text-sm text-slate-500">No dispatches scheduled this week</p>
            ) : (
              dispatchThisWeek.map((job) => {
                const dueStr = new Date(job.dueDate).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })
                const qaReleased = job.artwork?.locksCompleted === 4
                return (
                  <div
                    key={job.id}
                    className="flex justify-between items-start gap-2 text-sm flex-wrap"
                  >
                    <span className="font-mono text-amber-300">{job.jobNumber}</span>
                    <span className="text-slate-300 truncate max-w-[120px]" title={job.productName}>
                      {job.productName}
                    </span>
                    <span className="text-slate-400">{job.qtyOrdered.toLocaleString()}</span>
                    <span className={`font-medium ${dueDateClass(job.dueDate)}`}>{dueStr}</span>
                    <span className="shrink-0" title={qaReleased ? 'QA released' : 'QA not released'}>
                      {qaReleased ? '✅' : '🔒'}
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
        <div className="rounded-xl bg-slate-800 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Quality Overview</h2>
          <div className="space-y-2">
            {(openNcrs || []).length === 0 ? (
              <p className="text-sm text-green-400">No open NCRs ✓</p>
            ) : (
              <>
                <p className="text-sm text-slate-300">
                  🔴 Critical: {ncrCountBySeverity.critical}
                </p>
                <p className="text-sm text-slate-300">
                  🟡 Major: {ncrCountBySeverity.major}
                </p>
                <p className="text-sm text-slate-300">
                  ⚪ Minor: {ncrCountBySeverity.minor}
                </p>
                <Link
                  href="/qms/ncr"
                  className="inline-block text-blue-400 text-sm mt-2 hover:underline"
                >
                  View all NCRs →
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
