'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import { PRODUCTION_STAGES } from '@/lib/constants'
import { ChevronDown, ChevronUp, CircleDollarSign, Star } from 'lucide-react'
import { OperatorProfileDrawer } from '@/components/industrial/OperatorProfileDrawer'
import { MachineHealthMeter } from '@/components/industrial/MachineHealthMeter'
import { PmSpotlightDrawer } from '@/components/industrial/PmSpotlightDrawer'
import { IndustrialModuleShell, industrialTableClassName } from '@/components/industrial/IndustrialModuleShell'
import { IndustrialKpiTile } from '@/components/industrial/IndustrialKpiTile'
import { AgeTickerCell } from '@/components/industrial/AgeTickerCell'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { PRODUCTION_DOWNTIME_CATEGORIES } from '@/lib/production-oee-constants'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type StageRecord = {
  id: string
  stageName: string
  status: string
  operator: string | null
  counter: number | null
  sheetSize: string | null
  completedAt: string | null
  createdAt: string
  lastProductionTickAt: string | null
  inProgressSince: string | null
}

type YieldM = {
  yieldPercent: number | null
  plannedWastePercent: number
  unexplainedWastePercent: number
  finishedGoodsCount: number
  totalSheetsIssuedFloor: number
}

type OeePayload = {
  oee: number
  availability: number
  performance: number
  quality: number
  currentSpeedPph: number
  ratedSpeedPph: number
  secondsSinceLastTick: number | null
  downtimeLock: boolean
  source: 'live' | 'ledger'
}

type MachinePmPayload = {
  machineId: string
  machineCode: string
  name: string
  healthPct: number
  hourHealth: number | null
  impressionHealth: number | null
  usageRunHours: number
  usageImpressions: string
  intervalRunHours: number | null
  intervalImpressions: string | null
  overdue: boolean
  hasSchedule: boolean
}

type JobCardSummary = {
  id: string
  jobCardNumber: number
  setNumber: string | null
  batchNumber: string | null
  requiredSheets: number
  totalSheets: number
  status: string
  customer: { id: string; name: string }
  productName: string | null
  updatedAt: string
  machineId: string | null
  machine: { id: string; machineCode: string; name: string; capacityPerShift: number } | null
  industrialPriority?: boolean
  yield: YieldM | null
  oee: OeePayload | null
  shiftOperator: { id: string; name: string } | null
  incentiveLedger: {
    incentiveEligible: boolean
    yieldPercent: number | null
    oeePct: number
    incentiveVerifiedAt: string | null
  } | null
  machinePm: MachinePmPayload | null
}

type Payload = {
  stageKey: string
  stageLabel: string
  jobCards: {
    stageRecord: StageRecord
    jobCard: JobCardSummary
    idleHours: number | null
  }[]
}

type SortKey =
  | 'jobCardNumber'
  | 'customer'
  | 'productName'
  | 'sheets'
  | 'stageStatus'
  | 'completedAt'

type HubOeeSummary = {
  plantOee: number | null
  topBottleneck: { reasonKey: string; hours: number } | null
  unplannedStops: number
}

type FactoryPmKpis = {
  factoryHealthAvg: number | null
  pmOverdueCount: number
  scheduledPmHoursThisWeek: number
}

function oeeBandClass(oee: number): string {
  if (oee >= 85) return 'text-emerald-500'
  if (oee >= 60) return 'text-amber-500'
  return 'text-rose-500'
}

export default function ProductionStagePage() {
  const params = useParams()
  const stageKey = params.stageKey as string
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<SortKey>('jobCardNumber')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [hubOee, setHubOee] = useState<HubOeeSummary | null>(null)
  const [factoryPm, setFactoryPm] = useState<FactoryPmKpis | null>(null)
  const [spotlight, setSpotlight] = useState<Payload['jobCards'][number] | null>(null)
  const [profileOperatorId, setProfileOperatorId] = useState<string | null>(null)
  const [pmMachineId, setPmMachineId] = useState<string | null>(null)
  const [incentiveBusy, setIncentiveBusy] = useState(false)

  const stageMeta = PRODUCTION_STAGES.find((s) => s.key === stageKey)

  const load = useCallback(async () => {
    if (!stageKey) return
    setLoading(true)
    try {
      const r = await fetch(`/api/production/stages/${stageKey}`)
      const json = (await r.json()) as Payload & { error?: string }
      if ((json as { error?: string }).error) throw new Error((json as { error: string }).error)
      setData(json)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [stageKey])

  const loadHubOee = useCallback(async () => {
    try {
      const r = await fetch('/api/production/oee-hub-summary')
      const j = (await r.json()) as HubOeeSummary & { error?: string }
      if (!j.error) setHubOee(j)
    } catch {
      setHubOee(null)
    }
  }, [])

  const loadFactoryPm = useCallback(async () => {
    try {
      const r = await fetch('/api/production/machine-health')
      const j = (await r.json()) as FactoryPmKpis & { error?: string }
      if (!j.error) {
        setFactoryPm({
          factoryHealthAvg: j.factoryHealthAvg ?? null,
          pmOverdueCount: j.pmOverdueCount ?? 0,
          scheduledPmHoursThisWeek: j.scheduledPmHoursThisWeek ?? 0,
        })
      }
    } catch {
      setFactoryPm(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadHubOee()
    void loadFactoryPm()
    const t = setInterval(() => {
      void loadHubOee()
      void loadFactoryPm()
    }, 30_000)
    return () => clearInterval(t)
  }, [loadHubOee, loadFactoryPm])

  useEffect(() => {
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    const onPri = () => {
      void load()
    }
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [load])

  const priorityPmRisk = useMemo(() => {
    const rows = data?.jobCards ?? []
    return rows.some(
      (x) =>
        x.jobCard.industrialPriority === true &&
        x.jobCard.machinePm != null &&
        x.jobCard.machinePm.hasSchedule &&
        x.jobCard.machinePm.healthPct < 50,
    )
  }, [data?.jobCards])

  const stageKpis = useMemo(() => {
    const rows = data?.jobCards ?? []
    const inProg = rows.filter((x) => x.stageRecord.status === 'in_progress').length
    const pending = rows.filter((x) => x.stageRecord.status === 'pending').length
    const done = rows.filter((x) => x.stageRecord.status === 'completed').length
    const pri = rows.filter((x) => x.jobCard.industrialPriority === true).length
    const idleHot = rows.filter(
      (x) => x.idleHours != null && x.idleHours > 2 && x.stageRecord.status !== 'completed',
    ).length
    return { inProg, pending, done, pri, idleHot, total: rows.length }
  }, [data?.jobCards])

  if (loading) {
    return (
      <IndustrialModuleShell title="Production stage" subtitle="Loading…">
        <p className="text-slate-500 text-sm">Loading…</p>
      </IndustrialModuleShell>
    )
  }

  if (!stageMeta && !data) {
    return (
      <IndustrialModuleShell title="Production stage" subtitle="">
        <p className="text-slate-400 text-sm">Unknown stage.</p>
        <Link href="/production/stages" className="text-amber-400 hover:underline mt-2 inline-block text-sm">
          ← All stages
        </Link>
      </IndustrialModuleShell>
    )
  }

  const label = data?.stageLabel ?? stageMeta?.label ?? stageKey
  const rawList = data?.jobCards ?? []

  const list = useMemo(() => {
    const arr = [...rawList]
    arr.sort((a, b) => {
      const pa = a.jobCard.industrialPriority === true ? 1 : 0
      const pb = b.jobCard.industrialPriority === true ? 1 : 0
      if (pa !== pb) return pb - pa
      let cmp = 0
      switch (sortBy) {
        case 'jobCardNumber':
          cmp = a.jobCard.jobCardNumber - b.jobCard.jobCardNumber
          break
        case 'customer':
          cmp = (a.jobCard.customer.name ?? '').localeCompare(b.jobCard.customer.name ?? '')
          break
        case 'productName':
          cmp = (a.jobCard.productName ?? '').localeCompare(b.jobCard.productName ?? '')
          break
        case 'sheets':
          cmp = a.jobCard.requiredSheets - b.jobCard.requiredSheets
          break
        case 'stageStatus':
          cmp = (a.stageRecord.status ?? '').localeCompare(b.stageRecord.status ?? '')
          break
        case 'completedAt': {
          const ta = a.stageRecord.completedAt ? new Date(a.stageRecord.completedAt).getTime() : 0
          const tb = b.stageRecord.completedAt ? new Date(b.stageRecord.completedAt).getTime() : 0
          cmp = ta - tb
          break
        }
        default:
          return 0
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [rawList, sortBy, sortDir])

  function toggleSort(key: SortKey) {
    setSortBy(key)
    setSortDir((d) => (sortBy === key ? (d === 'asc' ? 'desc' : 'asc') : 'asc'))
  }

  async function verifyPerformanceIncentive(jobCardId: string) {
    setIncentiveBusy(true)
    try {
      const res = await fetch('/api/production/incentive-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productionJobCardId: jobCardId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((j as { error?: string }).error || 'Verify failed')
      toast.success((j as { message?: string }).message ?? 'Incentive verified')
      await load()
      setSpotlight((prev) =>
        prev && prev.jobCard.id === jobCardId
          ? {
              ...prev,
              jobCard: {
                ...prev.jobCard,
                incentiveLedger: prev.jobCard.incentiveLedger
                  ? {
                      ...prev.jobCard.incentiveLedger,
                      incentiveVerifiedAt: (j as { incentiveVerifiedAt?: string }).incentiveVerifiedAt ?? new Date().toISOString(),
                    }
                  : null,
              },
            }
          : prev,
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setIncentiveBusy(false)
    }
  }

  function SortHeader({
    columnKey,
    children,
  }: {
    columnKey: SortKey
    children: React.ReactNode
  }) {
    const active = sortBy === columnKey
    return (
      <th
        className="px-4 py-2 cursor-pointer select-none hover:bg-slate-800/50 text-left"
        onClick={() => toggleSort(columnKey)}
      >
        <span className="flex items-center gap-1">
          {children}
          {active ? (sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />) : null}
        </span>
      </th>
    )
  }

  const bottleneckLabel = hubOee?.topBottleneck
    ? PRODUCTION_DOWNTIME_CATEGORIES.find((c) => c.key === hubOee.topBottleneck!.reasonKey)?.label ??
      hubOee.topBottleneck.reasonKey
    : '—'

  return (
    <>
    <IndustrialModuleShell
      title={label}
      subtitle={
        `${stageKpis.total} job card${stageKpis.total !== 1 ? 's' : ''} at this stage` +
        (['chemical_coating', 'lamination', 'spot_uv', 'leafing', 'embossing'].includes(stageKey)
          ? ' · Filtered by post-press routing'
          : '') +
        '. OEE ticker ~20s refresh; downtime lock at 10m without counter pulse on tablet.'
      }
      kpiRow={
        <>
          <div className="col-span-2 grid grid-cols-2 gap-2 md:col-span-2 lg:col-span-4 lg:grid-cols-4">
            <IndustrialKpiTile label="Active" value={stageKpis.total} hint="Rows in list" />
            <IndustrialKpiTile label="In progress" value={stageKpis.inProg} hint="Running now" />
            <IndustrialKpiTile label="Pending" value={stageKpis.pending} hint="Awaiting start" />
            <IndustrialKpiTile
              label="Priority · Idle >2h"
              value={`${stageKpis.pri} · ${stageKpis.idleHot}`}
              hint="Golden-orange priority · idle threshold"
              valueClassName={
                stageKpis.idleHot > 0
                  ? 'text-rose-300'
                  : stageKpis.pri > 0
                    ? 'text-orange-400'
                    : 'text-slate-100'
              }
              shellClassName={stageKpis.pri > 0 ? 'ring-1 ring-orange-500/30' : ''}
            />
          </div>
          <div className="col-span-2 grid grid-cols-2 gap-2 md:col-span-2 lg:col-span-4 lg:grid-cols-3">
            <IndustrialKpiTile
              label="Plant OEE"
              value={
                hubOee?.plantOee != null ? (
                  <span className={mono}>{hubOee.plantOee}%</span>
                ) : (
                  <span className="text-slate-500">N/A</span>
                )
              }
              valueClassName={`${mono} text-emerald-400`}
              hint="7d weighted from production ledger"
            />
            <IndustrialKpiTile
              label="Top bottleneck"
              value={<span className={`${mono} text-rose-300 text-lg`}>{bottleneckLabel}</span>}
              hint={
                hubOee?.topBottleneck
                  ? `${hubOee.topBottleneck.hours}h downtime this week`
                  : 'By downtime category'
              }
            />
            <IndustrialKpiTile
              label="Unplanned stops"
              value={<span className={mono}>{hubOee?.unplannedStops ?? '—'}</span>}
              hint="Excludes changeover/setup (7d)"
              valueClassName={`${mono} text-amber-400`}
            />
          </div>
          <div className="col-span-2 grid grid-cols-1 gap-2 sm:grid-cols-3 md:col-span-2 lg:col-span-4 xl:col-span-6 2xl:col-span-6">
            <IndustrialKpiTile
              label="Factory health"
              value={
                factoryPm?.factoryHealthAvg != null ? (
                  <span className={mono}>{factoryPm.factoryHealthAvg}%</span>
                ) : (
                  <span className="text-slate-500">N/A</span>
                )
              }
              valueClassName={`${mono} text-emerald-400`}
              hint="Average PM health — machines with a schedule"
              shellClassName="ring-1 ring-emerald-500/20"
            />
            <IndustrialKpiTile
              label="PM overdue"
              value={<span className={mono}>{factoryPm?.pmOverdueCount ?? '—'}</span>}
              valueClassName={`${mono} text-rose-400`}
              hint="Machines below 50% health"
              shellClassName="ring-1 ring-rose-500/20"
            />
            <IndustrialKpiTile
              label="Scheduled PM (h, week)"
              value={<span className={mono}>{factoryPm?.scheduledPmHoursThisWeek ?? '—'}</span>}
              valueClassName={`${mono} text-amber-300`}
              hint="Planned downtime windows overlapping this week"
              shellClassName="ring-1 ring-amber-500/15"
            />
          </div>
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/production/stages"
          className="text-sm text-slate-400 hover:text-white"
        >
          ← All stages
        </Link>
        <Link
          href="/production/job-cards"
          className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm hover:bg-slate-900"
        >
          Job Cards
        </Link>
      </div>

      {priorityPmRisk ? (
        <div
          className="rounded-lg border-2 border-rose-500 bg-rose-950/95 px-4 py-3 shadow-[0_0_28px_rgba(244,63,94,0.45)] animate-pulse"
          role="alert"
        >
          <p className={`${mono} text-sm font-semibold text-rose-100 tracking-tight`}>
            RISK: Running priority job on overdue machine.
          </p>
          <p className="text-[11px] text-rose-200/80 mt-1">
            Director priority is queued on a press below 50% maintenance health. Reassign or complete PM before
            production commitment.
          </p>
        </div>
      ) : null}

      <div className={industrialTableClassName()}>
        <table className="w-full text-sm text-left border-collapse">
          <thead className="bg-slate-950/90 text-slate-400 border-b border-slate-800">
            <tr>
              <SortHeader columnKey="jobCardNumber">JC#</SortHeader>
              <SortHeader columnKey="customer">Customer</SortHeader>
              <SortHeader columnKey="productName">Product</SortHeader>
              <th className="px-4 py-2">Set / Batch</th>
              <SortHeader columnKey="sheets">Sheets</SortHeader>
              <th className="px-4 py-2">Yield</th>
              <th className="px-4 py-2">Health</th>
              <th className="px-4 py-2">OEE %</th>
              <th className="px-4 py-2">Speed</th>
              <SortHeader columnKey="stageStatus">Stage status</SortHeader>
              <th className="px-4 py-2">Age / idle</th>
              <th className="px-4 py-2">Operator</th>
              <SortHeader columnKey="completedAt">Completed</SortHeader>
              <th className="px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {list.map((row) => {
              const { stageRecord, jobCard, idleHours } = row
              const pri =
                jobCard.industrialPriority === true
                  ? 'shadow-[inset_0_0_0_1px_rgba(251,146,60,0.45)] bg-orange-950/20'
                  : ''
              const lock = jobCard.oee?.downtimeLock === true
              return (
                <tr
                  key={stageRecord.id}
                  className={`hover:bg-slate-900/50 cursor-pointer ${pri} ${lock ? 'ring-1 ring-rose-500/40' : ''}`}
                  onClick={() => setSpotlight(row)}
                >
                  <td className="px-4 py-2 font-mono text-amber-300">{jobCard.jobCardNumber}</td>
                  <td className="px-4 py-2 text-slate-200">{jobCard.customer.name}</td>
                  <td className="px-4 py-2 text-slate-300 max-w-[200px] truncate" title={jobCard.productName ?? ''}>
                    {jobCard.productName ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-300">
                    {jobCard.setNumber ?? '—'} / {jobCard.batchNumber ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-300">
                    {jobCard.requiredSheets} / {jobCard.totalSheets}
                  </td>
                  <td className="px-4 py-2">
                    {jobCard.yield?.yieldPercent != null ? (
                      <div
                        className={`flex items-center gap-1 font-designing-queue tabular-nums text-sm ${
                          jobCard.yield.yieldPercent < 92
                            ? 'text-rose-400 animate-yield-wastage-pulse'
                            : 'text-orange-300'
                        }`}
                        title={`Planned waste: ${jobCard.yield.plannedWastePercent}% | Unexplained waste: ${jobCard.yield.unexplainedWastePercent}% · FG: ${jobCard.yield.finishedGoodsCount}`}
                      >
                        {jobCard.yield.yieldPercent >= 92 ? (
                          <Star className="h-3.5 w-3.5 shrink-0 text-orange-400 fill-orange-400 drop-shadow-[0_0_6px_rgba(251,146,60,0.85)]" />
                        ) : null}
                        <span>{jobCard.yield.yieldPercent}%</span>
                      </div>
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    {jobCard.machine && jobCard.machinePm?.hasSchedule ? (
                      <MachineHealthMeter
                        healthPct={jobCard.machinePm.healthPct}
                        hasSchedule
                        onClick={() => setPmMachineId(jobCard.machine!.id)}
                        title="Preventive maintenance"
                      />
                    ) : jobCard.machine ? (
                      <MachineHealthMeter healthPct={0} hasSchedule={false} />
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                  <td className={`px-4 py-2 ${mono} text-sm`}>
                    {jobCard.oee != null ? (
                      <span
                        className={
                          jobCard.industrialPriority
                            ? `${oeeBandClass(jobCard.oee.oee)} drop-shadow-[0_0_10px_rgba(251,146,60,0.35)]`
                            : oeeBandClass(jobCard.oee.oee)
                        }
                      >
                        {jobCard.oee.oee}%
                      </span>
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                  <td
                    className={`px-4 py-2 ${mono} text-xs ${
                      lock ? 'text-rose-400 animate-pulse' : 'text-slate-300'
                    }`}
                  >
                    {jobCard.oee != null && jobCard.oee.ratedSpeedPph > 0 ? (
                      <span title="Sheets per hour vs rated">
                        {jobCard.oee.currentSpeedPph} / {Math.round(jobCard.oee.ratedSpeedPph)} sh/h
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs border ${
                        stageRecord.status === 'completed'
                          ? 'bg-green-900/40 text-green-300 border-green-600'
                          : stageRecord.status === 'in_progress'
                            ? 'bg-blue-900/40 text-blue-300 border-blue-600'
                            : 'bg-slate-800 text-slate-400 border-slate-600'
                      }`}
                    >
                      {stageRecord.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {stageRecord.status === 'completed' ? (
                      <span className="text-slate-500 text-xs">—</span>
                    ) : (
                      <AgeTickerCell
                        referenceIso={stageRecord.createdAt}
                        mode="productionIdle2h"
                        idleHours={idleHours ?? undefined}
                      />
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-300">
                    {jobCard.shiftOperator ? (
                      <button
                        type="button"
                        className="text-orange-300 hover:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          setProfileOperatorId(jobCard.shiftOperator!.id)
                        }}
                      >
                        {jobCard.shiftOperator.name}
                      </button>
                    ) : (
                      <span className="text-slate-500">{stageRecord.operator ?? '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-400 text-xs">
                    {stageRecord.completedAt
                      ? new Date(stageRecord.completedAt).toLocaleString()
                      : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/production/job-cards/${jobCard.id}`}
                      className="text-amber-400 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open JC
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {stageKey === 'dye_cutting' && list.some((x) => x.stageRecord.status === 'completed') ? (
        <div className="rounded-xl border border-amber-700 bg-amber-950/30 p-4">
          <p className="text-amber-200 font-medium">⚠ DIE RETURN REQUIRED</p>
          <p className="text-xs text-amber-300 mt-1">
            Die Cutting completed jobs should return dies immediately with run impressions and condition.
          </p>
          <p className="text-xs text-slate-300 mt-2">
            Open the job card, use the Die panel, then click <span className="font-semibold">Confirm Return</span>.
          </p>
        </div>
      ) : null}

      {stageKey === 'embossing' && list.some((x) => x.stageRecord.status === 'completed') ? (
        <div className="rounded-xl border border-amber-700 bg-amber-950/30 p-4">
          <p className="text-amber-200 font-medium">⚠ EMBOSS BLOCK RETURN REQUIRED</p>
          <p className="text-xs text-amber-300 mt-1">
            Embossing completed jobs should return blocks immediately with impressions and condition.
          </p>
          <p className="text-xs text-slate-300 mt-2">
            Open the job card and complete block return from the Emboss Block panel.
          </p>
        </div>
      ) : null}

      {list.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">
          No job cards at this stage. Create job cards and advance them from the Job Card detail.
        </p>
      )}
    </IndustrialModuleShell>

    <SlideOverPanel
      title={
        spotlight
          ? `JC#${spotlight.jobCard.jobCardNumber} · ${spotlight.stageRecord.stageName}`
          : 'Machine pulse'
      }
      isOpen={spotlight != null}
      onClose={() => setSpotlight(null)}
      widthClass="max-w-md"
    >
      {spotlight ? (
        <div className="space-y-4 text-sm text-slate-300">
          {spotlight.jobCard.oee ? (
            <>
              <p className={`${mono} text-2xl ${oeeBandClass(spotlight.jobCard.oee.oee)}`}>
                OEE {spotlight.jobCard.oee.oee}%
              </p>
              <div className={`grid grid-cols-3 gap-2 text-xs ${mono}`}>
                <div>
                  <div className="text-slate-500">A</div>
                  <div className="text-slate-200">{spotlight.jobCard.oee.availability}%</div>
                </div>
                <div>
                  <div className="text-slate-500">P</div>
                  <div className="text-slate-200">{spotlight.jobCard.oee.performance}%</div>
                </div>
                <div>
                  <div className="text-slate-500">Q</div>
                  <div className="text-slate-200">{spotlight.jobCard.oee.quality}%</div>
                </div>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  Live speedometer (sheets/h)
                </p>
                <div className="h-3 w-full rounded-full bg-zinc-900 border border-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-orange-600 to-amber-400 transition-all duration-500"
                    style={{
                      width: `${Math.min(
                        100,
                        spotlight.jobCard.oee.ratedSpeedPph > 0
                          ? (spotlight.jobCard.oee.currentSpeedPph / spotlight.jobCard.oee.ratedSpeedPph) * 100
                          : 0,
                      )}%`,
                    }}
                  />
                </div>
                <p className={`mt-1 ${mono} text-slate-200`}>
                  {spotlight.jobCard.oee.currentSpeedPph} / {Math.round(spotlight.jobCard.oee.ratedSpeedPph)} sh/h
                  <span className="text-slate-500 ml-2">limit</span>
                </p>
              </div>
              {spotlight.jobCard.machine ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xs text-slate-500">
                    Press {spotlight.jobCard.machine.machineCode} · {spotlight.jobCard.machine.name}
                  </p>
                  {spotlight.jobCard.machinePm?.hasSchedule ? (
                    <MachineHealthMeter
                      healthPct={spotlight.jobCard.machinePm.healthPct}
                      hasSchedule
                      onClick={() => setPmMachineId(spotlight.jobCard.machine!.id)}
                      title="Open PM checklist"
                    />
                  ) : null}
                </div>
              ) : null}
              {spotlight.jobCard.oee.downtimeLock ? (
                <p className="text-rose-400 text-xs">Downtime lock — log reason on shopfloor terminal.</p>
              ) : null}
            </>
          ) : (
            <p className="text-slate-500 text-sm">No live OEE for this row (start stage to see metrics).</p>
          )}
          {spotlight.jobCard.incentiveLedger?.incentiveEligible ? (
            <div className="flex items-start gap-3 rounded-lg border border-emerald-500/50 bg-emerald-950/25 px-3 py-3">
              <CircleDollarSign className="h-7 w-7 text-emerald-500 shrink-0" strokeWidth={1.75} />
              <div className="space-y-1">
                <p className="text-emerald-400 text-xs font-semibold uppercase tracking-wide">
                  Incentive earned
                </p>
                <p className={`text-xs text-slate-400 ${mono}`}>
                  Ledger yield {spotlight.jobCard.incentiveLedger.yieldPercent ?? '—'}% · OEE{' '}
                  {spotlight.jobCard.incentiveLedger.oeePct}%
                </p>
                {spotlight.jobCard.incentiveLedger.incentiveVerifiedAt ? (
                  <p className="text-emerald-600 text-[10px]">Performance incentive verified</p>
                ) : (
                  <button
                    type="button"
                    disabled={incentiveBusy}
                    onClick={() => void verifyPerformanceIncentive(spotlight.jobCard.id)}
                    className="mt-1 px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-50"
                  >
                    {incentiveBusy ? '…' : 'Verify performance incentive'}
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </SlideOverPanel>
    <OperatorProfileDrawer operatorId={profileOperatorId} onClose={() => setProfileOperatorId(null)} />
    <PmSpotlightDrawer
      machineId={pmMachineId}
      onClose={() => setPmMachineId(null)}
      onSignedOff={() => void load()}
    />
    </>
  )
}
