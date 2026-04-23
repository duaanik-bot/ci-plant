'use client'

import { useMemo } from 'react'
import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  Layers,
  BarChart2,
  Star,
  PauseCircle,
} from 'lucide-react'
import { readPlanningCore, PLANNING_DESIGNERS } from '@/lib/planning-decision-spec'

const mono = 'font-designing-queue tabular-nums tracking-tight'

const STATUS_META: Record<string, { label: string; dot: string; text: string }> = {
  pending:    { label: 'Pending',    dot: 'bg-ds-warning',  text: 'text-ds-warning'  },
  planned:    { label: 'Planned',    dot: 'bg-ds-brand',    text: 'text-ds-brand'    },
  processing: { label: 'Processing', dot: 'bg-sky-400',     text: 'text-sky-400'     },
  closed:     { label: 'Closed',     dot: 'bg-ds-success',  text: 'text-ds-success'  },
}

const BATCH_META: Record<string, { label: string; dot: string }> = {
  draft:                  { label: 'Draft',        dot: 'bg-ds-ink-faint'  },
  ready:                  { label: 'Ready',        dot: 'bg-sky-400'       },
  approved_for_artwork:   { label: 'AW approved',  dot: 'bg-violet-400'    },
  released_to_production: { label: 'Production',   dot: 'bg-ds-success'    },
  hold:                   { label: 'On Hold',      dot: 'bg-ds-warning'    },
}

type BlockerEntry = { label: string; count: number }

type SummaryRow = {
  id: string
  planningStatus: string
  quantity: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  specOverrides: Record<string, any> | null
  directorPriority?: boolean
  directorHold?: boolean
}

type Props = {
  rows: SummaryRow[]
  blockerData: BlockerEntry[]
  readyToScheduleCount: number
  totalQty: number
}

function SectionTitle({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-ds-ink-faint" aria-hidden />
      <span className="text-[10px] font-bold uppercase tracking-widest text-ds-ink-faint">{label}</span>
    </div>
  )
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100)
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ds-elevated/60">
      <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function PlanningSummaryPanel({ rows, blockerData, readyToScheduleCount, totalQty }: Props) {
  /* ── Status breakdown ── */
  const statusCounts = useMemo(() => {
    const counts: Record<string, { count: number; qty: number }> = {}
    for (const r of rows) {
      const st = r.planningStatus || 'pending'
      if (!counts[st]) counts[st] = { count: 0, qty: 0 }
      counts[st].count++
      counts[st].qty += r.quantity || 0
    }
    return counts
  }, [rows])

  const totalRows = rows.length

  /* ── Batch status breakdown ── */
  const batchCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const r of rows) {
      if (r.planningStatus === 'closed') continue
      const core = readPlanningCore((r.specOverrides || {}) as Record<string, unknown>)
      const bs = core.batchStatus || 'draft'
      counts[bs] = (counts[bs] || 0) + 1
    }
    return counts
  }, [rows])

  /* ── Designer breakdown ── */
  const designerCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const r of rows) {
      if (r.planningStatus === 'closed') continue
      const core = readPlanningCore((r.specOverrides || {}) as Record<string, unknown>)
      if (core.designerKey) {
        const name = PLANNING_DESIGNERS[core.designerKey] || core.designerKey
        counts[name] = (counts[name] || 0) + 1
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  }, [rows])

  const unassignedCount = useMemo(() => {
    return rows.filter((r) => {
      if (r.planningStatus === 'closed') return false
      const core = readPlanningCore((r.specOverrides || {}) as Record<string, unknown>)
      return !core.designerKey
    }).length
  }, [rows])

  /* ── Priority / hold ── */
  const priorityCount = rows.filter((r) => r.directorPriority).length
  const holdCount = rows.filter((r) => r.directorHold).length

  /* ── Top blockers (cap at 5) ── */
  const topBlockers = blockerData.slice(0, 5)

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto overflow-x-hidden px-2.5 py-3 text-ds-ink">

      {/* ── Queue health ── */}
      <div className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/20 p-3">
        <SectionTitle icon={BarChart2} label="Queue health" />
        <div className="space-y-2">
          {Object.entries(STATUS_META).map(([st, meta]) => {
            const d = statusCounts[st] || { count: 0, qty: 0 }
            if (d.count === 0) return null
            return (
              <div key={st}>
                <div className="mb-0.5 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${meta.dot}`} />
                    <span className="text-[12px] text-ds-ink-muted">{meta.label}</span>
                  </div>
                  <span className={`text-[12px] font-semibold ${mono} ${meta.text}`}>
                    {d.count}
                    <span className="ml-1 text-[10px] font-normal text-ds-ink-faint">
                      ({d.qty.toLocaleString('en-IN')} pcs)
                    </span>
                  </span>
                </div>
                <MiniBar value={d.count} max={totalRows} color={meta.dot} />
              </div>
            )
          })}
          {totalRows === 0 && (
            <p className="text-[12px] text-ds-ink-faint">No lines in queue</p>
          )}
        </div>
      </div>

      {/* ── Readiness KPIs ── */}
      <div className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/20 p-3">
        <SectionTitle icon={CheckCircle2} label="Readiness" />
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-ds-sm border border-ds-success/20 bg-ds-success/5 px-2.5 py-2 text-center">
            <p className={`text-[22px] font-bold leading-none text-ds-success ${mono}`}>
              {readyToScheduleCount}
            </p>
            <p className="mt-0.5 text-[10px] text-ds-ink-faint">Ready to schedule</p>
          </div>
          <div className="rounded-ds-sm border border-ds-line/50 bg-ds-elevated/30 px-2.5 py-2 text-center">
            <p className={`text-[22px] font-bold leading-none text-ds-ink ${mono}`}>
              {totalRows - readyToScheduleCount - (statusCounts['closed']?.count || 0)}
            </p>
            <p className="mt-0.5 text-[10px] text-ds-ink-faint">Needs attention</p>
          </div>
          {priorityCount > 0 && (
            <div className="rounded-ds-sm border border-yellow-500/30 bg-yellow-500/5 px-2.5 py-2 text-center">
              <p className={`text-[22px] font-bold leading-none text-yellow-400 ${mono}`}>
                {priorityCount}
              </p>
              <p className="mt-0.5 text-[10px] text-ds-ink-faint">Director priority</p>
            </div>
          )}
          {holdCount > 0 && (
            <div className="rounded-ds-sm border border-ds-error/20 bg-ds-error/5 px-2.5 py-2 text-center">
              <p className={`text-[22px] font-bold leading-none text-ds-error ${mono}`}>
                {holdCount}
              </p>
              <p className="mt-0.5 text-[10px] text-ds-ink-faint">On director hold</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Top blockers ── */}
      {topBlockers.length > 0 && (
        <div className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/20 p-3">
          <SectionTitle icon={AlertTriangle} label="Top blockers" />
          <div className="space-y-1.5">
            {topBlockers.map((b, i) => (
              <div key={b.label} className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={`text-[10px] font-bold ${mono} text-ds-ink-faint`}>
                    {i + 1}.
                  </span>
                  <span className="truncate text-[12px] text-ds-ink-muted">{b.label}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <MiniBar value={b.count} max={topBlockers[0]?.count || 1} color="bg-ds-error/60" />
                  <span className={`min-w-[1.5rem] text-right text-[12px] font-semibold text-ds-error ${mono}`}>
                    {b.count}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Batch status ── */}
      {Object.keys(batchCounts).length > 0 && (
        <div className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/20 p-3">
          <SectionTitle icon={Layers} label="Batch status" />
          <div className="space-y-1.5">
            {Object.entries(BATCH_META).map(([key, meta]) => {
              const n = batchCounts[key]
              if (!n) return null
              const totalBatch = Object.values(batchCounts).reduce((a, b) => a + b, 0)
              return (
                <div key={key}>
                  <div className="mb-0.5 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${meta.dot}`} />
                      <span className="text-[12px] text-ds-ink-muted">{meta.label}</span>
                    </div>
                    <span className={`text-[12px] font-semibold ${mono} text-ds-ink`}>{n}</span>
                  </div>
                  <MiniBar value={n} max={totalBatch} color={meta.dot} />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Designer workload ── */}
      {(designerCounts.length > 0 || unassignedCount > 0) && (
        <div className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/20 p-3">
          <SectionTitle icon={Clock} label="Designer workload" />
          <div className="space-y-1">
            {designerCounts.map(([name, count]) => {
              const total = designerCounts.reduce((a, [, c]) => a + c, 0) + unassignedCount
              return (
                <div key={name}>
                  <div className="mb-0.5 flex items-center justify-between">
                    <span className="truncate text-[12px] text-ds-ink-muted">{name}</span>
                    <span className={`ml-1 shrink-0 text-[12px] font-semibold text-ds-brand ${mono}`}>{count}</span>
                  </div>
                  <MiniBar value={count} max={total} color="bg-ds-brand/60" />
                </div>
              )
            })}
            {unassignedCount > 0 && (
              <div>
                <div className="mb-0.5 flex items-center justify-between">
                  <span className="text-[12px] text-ds-ink-faint">Unassigned</span>
                  <span className={`text-[12px] font-semibold text-ds-ink-faint ${mono}`}>
                    {unassignedCount}
                  </span>
                </div>
                <MiniBar
                  value={unassignedCount}
                  max={designerCounts.reduce((a, [, c]) => a + c, 0) + unassignedCount}
                  color="bg-ds-ink-faint/40"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Qty summary ── */}
      <div className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/20 p-3">
        <SectionTitle icon={Star} label="Qty summary" />
        <div className="space-y-1.5">
          {Object.entries(STATUS_META).map(([st, meta]) => {
            const d = statusCounts[st]
            if (!d || d.qty === 0) return null
            return (
              <div key={st} className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${meta.dot}`} />
                  <span className="text-[12px] text-ds-ink-muted">{meta.label}</span>
                </div>
                <span className={`text-[12px] font-semibold text-ds-ink ${mono}`}>
                  {d.qty.toLocaleString('en-IN')}
                </span>
              </div>
            )
          })}
          <div className="mt-1.5 border-t border-ds-line/40 pt-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-ds-ink">Total</span>
              <span className={`text-[14px] font-bold text-ds-success ${mono}`}>
                {totalQty.toLocaleString('en-IN')}
              </span>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
