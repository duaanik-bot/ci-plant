'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { PRODUCTION_STAGES } from '@/lib/constants'
import { ProductionScheduleBoardContainer } from '@/components/planning/ProductionScheduleBoardContainer'
import { IndustrialKpiTile } from '@/components/industrial/IndustrialKpiTile'
import { OeeSparkline } from '@/components/industrial/OeeSparkline'
import { OperatorProfileDrawer } from '@/components/industrial/OperatorProfileDrawer'
import { MachineHealthMeter } from '@/components/industrial/MachineHealthMeter'
import { PmSpotlightDrawer } from '@/components/industrial/PmSpotlightDrawer'
import { Star } from 'lucide-react'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type YieldSummary = {
  netYieldPercent: number | null
  wasteValueInrMonth: number
  topAnomaly: { poNumber: string; variancePercent: number; jobCardNumber: number } | null
}

type MachinePmRow = {
  machineId: string
  machineCode: string
  name: string
  healthPct: number
  hasSchedule: boolean
  overdue: boolean
  usageRunHours: number
  usageImpressions: string
}

type LeaderboardRow = {
  userId: string
  name: string
  rank: number
  performanceIndex: number
  avgOee: number
  avgYield: number
  downtimeEfficiency: number
  oeeSparkline: number[]
  jobCount: number
  underperformer: boolean
}

export default function ProductionStagesHubPage() {
  const [yieldSummary, setYieldSummary] = useState<YieldSummary | null>(null)
  const [yieldLoading, setYieldLoading] = useState(true)
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)
  const [profileOperatorId, setProfileOperatorId] = useState<string | null>(null)
  const [pmHealth, setPmHealth] = useState<{
    factoryHealthAvg: number | null
    pmOverdueCount: number
    scheduledPmHoursThisWeek: number
    machines: MachinePmRow[]
  } | null>(null)
  const [pmLoading, setPmLoading] = useState(true)
  const [pmMachineId, setPmMachineId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/production/yield-summary')
        const j = (await r.json()) as YieldSummary & { error?: string }
        if (!cancelled && !j.error) setYieldSummary(j)
      } catch {
        if (!cancelled) setYieldSummary(null)
      } finally {
        if (!cancelled) setYieldLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/production/operator-leaderboard')
        const j = (await r.json()) as { operators?: LeaderboardRow[]; error?: string }
        if (!cancelled && !j.error && j.operators) setLeaderboard(j.operators)
      } catch {
        if (!cancelled) setLeaderboard([])
      } finally {
        if (!cancelled) setLeaderboardLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/production/machine-health')
        const j = (await r.json()) as {
          factoryHealthAvg?: number | null
          pmOverdueCount?: number
          scheduledPmHoursThisWeek?: number
          machines?: MachinePmRow[]
          error?: string
        }
        if (!cancelled && !j.error && j.machines) {
          setPmHealth({
            factoryHealthAvg: j.factoryHealthAvg ?? null,
            pmOverdueCount: j.pmOverdueCount ?? 0,
            scheduledPmHoursThisWeek: j.scheduledPmHoursThisWeek ?? 0,
            machines: j.machines,
          })
        }
      } catch {
        if (!cancelled) setPmHealth(null)
      } finally {
        if (!cancelled) setPmLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
    <div className="min-h-screen bg-background text-ds-ink">
      <div className="p-4 max-w-5xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-orange-400">Production Planning</h1>
          <div className="flex items-center gap-2">
            <Link
              href="/orders/planning"
              className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm"
            >
              Planning
            </Link>
            <Link
              href="/production/job-cards"
              className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm"
            >
              Job Cards
            </Link>
          </div>
        </div>

        <section aria-label="Production schedule shift grid">
          <ProductionScheduleBoardContainer />
        </section>

        <section className="rounded-2xl border border-border/10 bg-background px-4 py-5 space-y-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
          <div className="flex items-center gap-2">
            <Star className="h-4 w-4 text-orange-400 fill-orange-400 drop-shadow-[0_0_8px_rgba(251,146,60,0.75)]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ds-ink-muted">
              Yield summary — Yield Guardian
            </h2>
          </div>
          <p className="text-xs text-ds-ink-faint">
            Net yield from active jobs; wastage value from material issued vs theoretical output this month.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <IndustrialKpiTile
              label="Net yield %"
              value={
                yieldLoading ? (
                  '…'
                ) : yieldSummary?.netYieldPercent != null ? (
                  <span className={mono}>{yieldSummary.netYieldPercent}%</span>
                ) : (
                  <span className="text-ds-ink-faint">N/A</span>
                )
              }
              valueClassName={`${mono} text-orange-300`}
              hint="Average across active jobs (issued vs theory)"
              shellClassName="ring-1 ring-orange-500/25"
            />
            <IndustrialKpiTile
              label="Waste value (₹)"
              value={
                yieldLoading ? (
                  '…'
                ) : (
                  <span className={mono}>
                    ₹
                    {yieldSummary?.wasteValueInrMonth.toLocaleString('en-IN', {
                      maximumFractionDigits: 0,
                    }) ?? '0'}
                  </span>
                )
              }
              valueClassName={`${mono} text-rose-400`}
              hint="This calendar month — unexplained kg × sheet rate"
              shellClassName="ring-1 ring-rose-500/20"
            />
            <IndustrialKpiTile
              label="Top anomaly"
              value={
                yieldLoading ? (
                  '…'
                ) : yieldSummary?.topAnomaly ? (
                  <span className={`${mono} text-rose-300 text-lg`}>
                    {yieldSummary.topAnomaly.poNumber}
                  </span>
                ) : (
                  <span className="text-ds-ink-faint">None flagged</span>
                )
              }
              valueClassName={mono}
              hint={
                yieldSummary?.topAnomaly
                  ? `Variance ≈ ${yieldSummary.topAnomaly.variancePercent}% · JC#${yieldSummary.topAnomaly.jobCardNumber}`
                  : 'Highest wastage variance among active jobs'
              }
              shellClassName="ring-1 ring-rose-500/15"
            />
          </div>
        </section>

        <section className="rounded-2xl border border-border/10 bg-background px-4 py-5 space-y-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ds-ink-muted">
            Machine health — PM scheduler
          </h2>
          <p className="text-xs text-ds-ink-faint">
            Health = worst of hour and impression progress vs service interval. Usage accrues from closed production
            ledger runs. Click the meter for checklist and sign-off.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <IndustrialKpiTile
              label="Factory health"
              value={
                pmLoading ? (
                  '…'
                ) : pmHealth?.factoryHealthAvg != null ? (
                  <span className={mono}>{pmHealth.factoryHealthAvg}%</span>
                ) : (
                  <span className="text-ds-ink-faint">N/A</span>
                )
              }
              valueClassName={`${mono} text-emerald-400`}
              hint="Average across scheduled machines"
              shellClassName="ring-1 ring-emerald-500/20"
            />
            <IndustrialKpiTile
              label="PM overdue"
              value={
                pmLoading ? '…' : <span className={mono}>{pmHealth?.pmOverdueCount ?? '—'}</span>
              }
              valueClassName={`${mono} text-rose-400`}
              hint="Below 50% health"
              shellClassName="ring-1 ring-rose-500/20"
            />
            <IndustrialKpiTile
              label="Scheduled PM (h, week)"
              value={
                pmLoading ? (
                  '…'
                ) : (
                  <span className={mono}>{pmHealth?.scheduledPmHoursThisWeek ?? '—'}</span>
                )
              }
              valueClassName={`${mono} text-ds-warning`}
              hint="Planned downtime overlapping this week"
              shellClassName="ring-1 ring-ds-warning/35"
            />
          </div>
          <div className="overflow-x-auto rounded-lg border border-ds-line/40">
            <table className="w-full text-sm text-left">
              <thead className="bg-ds-main text-neutral-500 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2">Machine</th>
                  <th className="px-3 py-2">Health</th>
                  <th className="px-3 py-2">Run hours</th>
                  <th className="px-3 py-2">Impressions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ds-card">
                {pmLoading ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-neutral-500">
                      Loading…
                    </td>
                  </tr>
                ) : (pmHealth?.machines ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-neutral-600 text-xs">
                      No machines.
                    </td>
                  </tr>
                ) : (
                  pmHealth!.machines.map((m) => (
                    <tr
                      key={m.machineId}
                      className={m.overdue ? 'bg-rose-950/25 border-l-4 border-rose-600' : ''}
                    >
                      <td className="px-3 py-2">
                        <span className={`${mono} text-orange-300`}>{m.machineCode}</span>
                        <span className="text-neutral-500 text-xs block truncate max-w-[200px]">{m.name}</span>
                      </td>
                      <td className="px-3 py-2">
                        <MachineHealthMeter
                          healthPct={m.healthPct}
                          hasSchedule={m.hasSchedule}
                          onClick={() => m.hasSchedule && setPmMachineId(m.machineId)}
                        />
                      </td>
                      <td className={`px-3 py-2 ${mono} text-neutral-500`}>
                        {m.hasSchedule ? m.usageRunHours : '—'}
                      </td>
                      <td className={`px-3 py-2 ${mono} text-neutral-500`}>
                        {m.hasSchedule ? m.usageImpressions : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-border/10 bg-background px-4 py-5 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ds-ink-muted">
            Top performers — operator performance index
          </h2>
          <p className="text-xs text-ds-ink-faint">
            Index = (Avg OEE × 0.4) + (Avg yield × 0.4) + (Downtime efficiency × 0.2). Sparkline = last 7
            closed jobs (OEE). Red-alert border = underperforming index.
          </p>
          <div className="overflow-x-auto rounded-lg border border-ds-line/40">
            <table className="w-full text-sm text-left">
              <thead className="bg-ds-main text-neutral-500 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2">Rank</th>
                  <th className="px-3 py-2">Operator</th>
                  <th className="px-3 py-2">Index</th>
                  <th className="px-3 py-2">OEE</th>
                  <th className="px-3 py-2">Yield</th>
                  <th className="px-3 py-2">Downtime eff.</th>
                  <th className="px-3 py-2">7-shift OEE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ds-card">
                {leaderboardLoading ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-neutral-500">
                      Loading…
                    </td>
                  </tr>
                ) : leaderboard.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-neutral-600 text-xs">
                      No attributed closed jobs in the last 28 days. Assign shift operators on job cards.
                    </td>
                  </tr>
                ) : (
                  leaderboard.map((row) => (
                    <tr
                      key={row.userId}
                      className={`hover:bg-ds-main/80 ${row.underperformer ? 'border-l-4 border-rose-600 bg-rose-950/10' : ''}`}
                    >
                      <td className={`px-3 py-2 ${mono} ${row.rank === 1 ? 'text-orange-400 font-semibold' : 'text-neutral-400'}`}>
                        {row.rank}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setProfileOperatorId(row.userId)}
                          className="text-left text-orange-300 hover:underline"
                        >
                          {row.name}
                        </button>
                      </td>
                      <td className={`px-3 py-2 ${mono} text-ds-ink`}>{row.performanceIndex}</td>
                      <td className={`px-3 py-2 ${mono} text-neutral-500`}>{row.avgOee}%</td>
                      <td className={`px-3 py-2 ${mono} text-neutral-500`}>{row.avgYield}%</td>
                      <td className={`px-3 py-2 ${mono} text-neutral-500`}>{row.downtimeEfficiency}%</td>
                      <td className="px-3 py-2">
                        <OeeSparkline values={row.oeeSparkline} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <p className="text-sm text-ds-ink-muted">
          Open a stage to see job cards at that step and update progress.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {PRODUCTION_STAGES.map((s, idx) => (
            <Link
              key={s.key}
              href={`/production/stages/${s.key}`}
              className="rounded-xl bg-ds-main border border-ds-line/40 p-4 hover:border-orange-500/50 flex items-center gap-3"
            >
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-lg bg-ds-card text-orange-400 ${mono} text-sm`}
              >
                {idx + 1}
              </span>
              <div>
                <p className="font-semibold text-ds-ink">{s.label}</p>
                <p className="text-xs text-ds-ink-faint">View job cards →</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
    <OperatorProfileDrawer operatorId={profileOperatorId} onClose={() => setProfileOperatorId(null)} />
    <PmSpotlightDrawer
      machineId={pmMachineId}
      onClose={() => setPmMachineId(null)}
      onSignedOff={() => {
        void fetch('/api/production/machine-health')
          .then((r) => r.json())
          .then((j: { machines?: MachinePmRow[]; factoryHealthAvg?: number | null; pmOverdueCount?: number; scheduledPmHoursThisWeek?: number }) => {
            if (j.machines) {
              setPmHealth({
                factoryHealthAvg: j.factoryHealthAvg ?? null,
                pmOverdueCount: j.pmOverdueCount ?? 0,
                scheduledPmHoursThisWeek: j.scheduledPmHoursThisWeek ?? 0,
                machines: j.machines as MachinePmRow[],
              })
            }
          })
      }}
    />
    </>
  )
}
