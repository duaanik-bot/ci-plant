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
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'
import {
  INDUSTRIAL_PRIORITY_ROW_CLASS,
  INDUSTRIAL_PRIORITY_STAR_ICON_CLASS,
} from '@/lib/industrial-priority-ui'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

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
  postPressRouting: Record<string, unknown> | null
  customer: { id: string; name: string }
  productName: string | null
  unifiedBodyId: string | null
  unifiedBodySize: number | null
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
  poMeta?: {
    poLineId: string
    poNumber: string
    poDate: string | null
    cartonName: string
    cartonSize: string | null
    quantity: number
    paperType: string | null
    coatingType: string | null
    otherCoating: string | null
    embossingLeafing: string | null
    gsm: number | null
    dyeId: string | null
    specOverrides: Record<string, unknown> | null
    carton: {
      artworkCode: string | null
      coatingType: string | null
      laminateType: string | null
      foilType: string | null
      embossingLeafing: string | null
      printingType: string | null
      pastingStyle: string | null
      colourBreakdown: unknown
    } | null
  } | null
  stageMap?: Record<string, { id: string; status: string; counter: number | null; operator: string | null; completedAt: string | null }>
  stageOutputs?: {
    cutting: number
    printing: number
    chemicalCoating: number
    lamination: number
    spotUv: number
    leafing: number
    embossing: number
    dyeCutting: number
    sorting: number
    pasting: number
  }
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

type StageProgress = {
  plannedQty: number
  completedQty: number
  pushedQty: number
  wastageQty: number
  status?: string
  expectedStartTime?: string | null
  expectedArrivalTime?: string | null
  estimatedCompletionTime?: string | null
  machineReserved?: string | null
  shiftReserved?: string | null
  approvalStatus?: 'pending' | 'approved' | 'rejected'
  approvedBy?: string | null
  approvedAt?: string | null
  completedBy?: string | null
  completedAt?: string | null
}

type ExecutionState = {
  supervisorApprovalEnabled?: boolean
  stageProgress?: Record<string, StageProgress>
  stagePushTrail?: Array<Record<string, unknown>>
  downtimeLogs?: Array<Record<string, unknown>>
  reworkTrail?: Array<Record<string, unknown>>
  checklistByStage?: Record<string, Record<string, boolean>>
}

const STAGES_WITH_STICKY_PUSH_TRACKING = new Set([
  'printing',
  'cutting',
  'chemical_coating',
  'lamination',
  'spot_uv',
  'dye_cutting',
  'pasting',
])

function oeeBandClass(oee: number): string {
  if (oee >= 85) return 'text-emerald-500'
  if (oee >= 60) return 'text-ds-warning'
  return 'text-rose-500'
}

export default function ProductionStagePage() {
  const params = useParams()
  const stageKey = params.stageKey as string
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<SortKey>('jobCardNumber')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [spotlight, setSpotlight] = useState<Payload['jobCards'][number] | null>(null)
  const [profileOperatorId, setProfileOperatorId] = useState<string | null>(null)
  const [pmMachineId, setPmMachineId] = useState<string | null>(null)
  const [incentiveBusy, setIncentiveBusy] = useState(false)
  const [counterDrafts, setCounterDrafts] = useState<Record<string, string>>({})
  const [operatorDrafts, setOperatorDrafts] = useState<Record<string, string>>({})
  const [pushDrafts, setPushDrafts] = useState<Record<string, string>>({})
  const [wastageDrafts, setWastageDrafts] = useState<Record<string, string>>({})
  const [checklistDrafts, setChecklistDrafts] = useState<Record<string, Record<string, boolean>>>({})
  const [tab, setTab] = useState<'pending' | 'make_ready' | 'running' | 'hold' | 'completed'>('pending')
  const [savingStageId, setSavingStageId] = useState<string | null>(null)
  const [selectedStageRecordIds, setSelectedStageRecordIds] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [showDowntime, setShowDowntime] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)

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

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onPri = () => {
      void load()
    }
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [load])

  const stageKpis = useMemo(() => {
    const rows = data?.jobCards ?? []
    const inProg = rows.filter((x) => x.stageRecord.status === 'in_progress').length
    const pending = rows.filter((x) => x.stageRecord.status === 'pending').length
    const done = rows.filter((x) => x.stageRecord.status === 'completed').length
    const partial = rows.filter((x) => {
      const ex = (x.jobCard.postPressRouting as Record<string, unknown> | null)?.executionOrchestration as ExecutionState | undefined
      const p = ex?.stageProgress?.[stageKey]
      return p != null && p.pushedQty > 0 && p.pushedQty < p.completedQty
    }).length
    const rework = rows.filter((x) => x.stageRecord.status === 'rework').length
    const pri = rows.filter((x) => x.jobCard.industrialPriority === true).length
    const idleHot = rows.filter(
      (x) => x.idleHours != null && x.idleHours > 2 && x.stageRecord.status !== 'completed',
    ).length
    return { inProg, pending, done, partial, rework, pri, idleHot, total: rows.length }
  }, [data?.jobCards])

  const label = data?.stageLabel ?? stageMeta?.label ?? stageKey
  const rawList = data?.jobCards ?? []
  const stickyPushTrackingEnabled = STAGES_WITH_STICKY_PUSH_TRACKING.has(stageKey)

  const list = useMemo(() => {
    const arr = [...rawList]
    arr.sort((a, b) => {
      const sa = String(getStageProgress(a).status ?? a.stageRecord.status ?? 'pending').toLowerCase()
      const sb = String(getStageProgress(b).status ?? b.stageRecord.status ?? 'pending').toLowerCase()
      if (sa === 'completed' && sb !== 'completed') return 1
      if (sb === 'completed' && sa !== 'completed') return -1
      const ta = getTriageMeta(a)
      const tb = getTriageMeta(b)
      if (ta.priorityRank !== tb.priorityRank) return ta.priorityRank - tb.priorityRank
      if (ta.sequenceNo !== tb.sequenceNo) return ta.sequenceNo - tb.sequenceNo
      if (ta.plannedStartTs !== tb.plannedStartTs) return ta.plannedStartTs - tb.plannedStartTs
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
    if (stickyPushTrackingEnabled) {
      const pendingRows: typeof arr = []
      const pushedRows: typeof arr = []
      for (const row of arr) {
        const pushedQty = Number(getStageProgress(row).pushedQty || 0)
        if (pushedQty > 0) pushedRows.push(row)
        else pendingRows.push(row)
      }
      return [...pendingRows, ...pushedRows]
    }
    return arr
  }, [rawList, sortBy, sortDir, stickyPushTrackingEnabled])

  function getTriageMeta(row: Payload['jobCards'][number]): { sequenceNo: number; priorityRank: number; plannedStartTs: number } {
    const ppr = row.jobCard.postPressRouting && typeof row.jobCard.postPressRouting === 'object'
      ? (row.jobCard.postPressRouting as Record<string, unknown>)
      : {}
    const exec =
      ppr.executionOrchestration && typeof ppr.executionOrchestration === 'object'
        ? (ppr.executionOrchestration as Record<string, unknown>)
        : {}
    const triageByStage =
      exec.triageByStage && typeof exec.triageByStage === 'object'
        ? (exec.triageByStage as Record<string, unknown>)
        : {}
    const stageTriage =
      triageByStage[stageKey] && typeof triageByStage[stageKey] === 'object'
        ? (triageByStage[stageKey] as Record<string, unknown>)
        : {}
    const item =
      stageTriage[row.stageRecord.id] && typeof stageTriage[row.stageRecord.id] === 'object'
        ? (stageTriage[row.stageRecord.id] as Record<string, unknown>)
        : {}
    const seq = Number(item.sequenceNo ?? 9999)
    const pri = Number(item.priorityRank ?? (row.jobCard.industrialPriority ? 1 : 100))
    const plannedStartRaw = String(item.plannedStartTime ?? '').trim()
    const ts = plannedStartRaw ? new Date(plannedStartRaw).getTime() : Number.MAX_SAFE_INTEGER
    return {
      sequenceNo: Number.isFinite(seq) ? seq : 9999,
      priorityRank: Number.isFinite(pri) ? pri : 100,
      plannedStartTs: Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER,
    }
  }

  const visibleList = useMemo(() => {
    return list.filter((row) => {
      const p = getStageProgress(row)
      const status = String(p.status ?? row.stageRecord.status ?? 'pending').toLowerCase()
      const pushedQty = Number(p.pushedQty || 0)
      if (tab === 'pending') {
        if (stickyPushTrackingEnabled && pushedQty > 0) return true
        return status === 'pending' || status === 'ready' || status === 'ready_to_receive'
      }
      if (tab === 'make_ready') return status === 'make_ready_alert' || status === 'make_ready_started' || status === 'ready_to_receive'
      if (tab === 'running') return status === 'in_progress' || status === 'partial_running' || status === 'rework'
      if (tab === 'hold') return status === 'hold' || status === 'blocked'
      return status === 'completed'
    })
  }, [list, tab, stickyPushTrackingEnabled])

  const selectedCount = selectedStageRecordIds.size
  const allVisibleSelected = visibleList.length > 0 && visibleList.every((r) => selectedStageRecordIds.has(r.stageRecord.id))

  function toggleRowSelection(stageRecordId: string, checked: boolean) {
    setSelectedStageRecordIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(stageRecordId)
      else next.delete(stageRecordId)
      return next
    })
  }

  function toggleVisibleSelection(checked: boolean) {
    setSelectedStageRecordIds((prev) => {
      const next = new Set(prev)
      if (checked) visibleList.forEach((r) => next.add(r.stageRecord.id))
      else visibleList.forEach((r) => next.delete(r.stageRecord.id))
      return next
    })
  }

  function selectAllInCurrentTab() {
    setSelectedStageRecordIds(new Set(visibleList.map((r) => r.stageRecord.id)))
  }

  if (loading) {
    return (
      <IndustrialModuleShell title="Production stage" subtitle="Loading…">
        <p className="text-ds-ink-faint text-sm">Loading…</p>
      </IndustrialModuleShell>
    )
  }

  if (!stageMeta && !data) {
    return (
      <IndustrialModuleShell title="Production stage" subtitle="">
        <p className="text-ds-ink-muted text-sm">Unknown stage.</p>
        <Link href="/production/stages" className="text-ds-warning hover:underline mt-2 inline-block text-sm">
          ← All stages
        </Link>
      </IndustrialModuleShell>
    )
  }

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
        className="px-4 py-2 cursor-pointer select-none hover:bg-ds-elevated/50 text-left"
        onClick={() => toggleSort(columnKey)}
      >
        <span className="flex items-center gap-1">
          {children}
          {active ? (sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />) : null}
        </span>
      </th>
    )
  }

  function getUpstreamSheets(row: Payload['jobCards'][number]): number {
    const prevKey = previousRequiredStageKey(row)
    if (prevKey) {
      const ex = getExecutionState(row)
      const prev = ex.stageProgress?.[prevKey]
      const pushed = Number(prev?.pushedQty ?? 0)
      if (Number.isFinite(pushed) && pushed > 0) return pushed
      const outputs = ((row.jobCard.stageOutputs as Record<string, unknown> | null) ?? {})
      const fromLegacy =
        prevKey === 'cutting'
          ? Number(outputs['cutting'] ?? 0)
          : prevKey === 'printing'
            ? Number(outputs['printing'] ?? 0)
            : prevKey === 'chemical_coating'
              ? Number(outputs['chemicalCoating'] ?? 0)
              : prevKey === 'lamination'
                ? Number(outputs['lamination'] ?? 0)
                : prevKey === 'spot_uv'
                  ? Number(outputs['spotUv'] ?? 0)
                  : prevKey === 'leafing'
                    ? Number(outputs['leafing'] ?? 0)
                    : prevKey === 'embossing'
                      ? Number(outputs['embossing'] ?? 0)
                      : prevKey === 'dye_cutting'
                        ? Number(outputs['dyeCutting'] ?? 0)
                        : prevKey === 'pasting'
                          ? Number(outputs['pasting'] ?? 0)
                          : prevKey === 'sorting'
                            ? Number(outputs['sorting'] ?? 0)
                            : 0
      if (Number.isFinite(fromLegacy) && fromLegacy > 0) return fromLegacy
      return 0
    }
    const outputs = row.jobCard.stageOutputs
    const fallback = row.jobCard.requiredSheets || row.jobCard.totalSheets || 0
    if (!outputs) return fallback
    if (stageKey === 'printing') return outputs.cutting || fallback
    if (stageKey === 'chemical_coating' || stageKey === 'lamination' || stageKey === 'spot_uv') {
      return outputs.printing || fallback
    }
    if (stageKey === 'leafing' || stageKey === 'embossing') {
      return (
        Math.max(outputs.chemicalCoating, outputs.lamination, outputs.spotUv, outputs.printing) || fallback
      )
    }
    if (stageKey === 'dye_cutting') {
      return (
        Math.max(
          outputs.embossing,
          outputs.leafing,
          outputs.chemicalCoating,
          outputs.lamination,
          outputs.spotUv,
          outputs.printing,
        ) || fallback
      )
    }
    if (stageKey === 'pasting') {
      return outputs.dyeCutting || outputs.sorting || fallback
    }
    return fallback
  }

  function getExecutionState(row: Payload['jobCards'][number]): ExecutionState {
    const pp = row.jobCard.postPressRouting
    const exec =
      pp && typeof pp === 'object' && (pp as Record<string, unknown>).executionOrchestration
        ? ((pp as Record<string, unknown>).executionOrchestration as ExecutionState)
        : {}
    return exec ?? {}
  }

  function getStageProgress(row: Payload['jobCards'][number], key = stageKey): StageProgress {
    const ex = getExecutionState(row)
    const existing = ex.stageProgress?.[key]
    const plannedFallback = stageKey === 'pasting' ? pastingExpectedCartons(row) : (row.jobCard.totalSheets || 0)
    const completedFallback = Number(getRowCounter(row) || 0)
    return {
      plannedQty: Number(existing?.plannedQty ?? plannedFallback) || 0,
      completedQty: Number(existing?.completedQty ?? completedFallback) || 0,
      pushedQty: Number(existing?.pushedQty ?? 0) || 0,
      wastageQty: Number(existing?.wastageQty ?? 0) || 0,
      status: existing?.status ?? row.stageRecord.status ?? 'pending',
      expectedStartTime: existing?.expectedStartTime ?? null,
      expectedArrivalTime: existing?.expectedArrivalTime ?? null,
      estimatedCompletionTime: existing?.estimatedCompletionTime ?? null,
      machineReserved: existing?.machineReserved ?? null,
      shiftReserved: existing?.shiftReserved ?? null,
      approvalStatus: existing?.approvalStatus,
      approvedBy: existing?.approvedBy ?? null,
      approvedAt: existing?.approvedAt ?? null,
      completedBy: existing?.completedBy ?? null,
      completedAt: existing?.completedAt ?? null,
    }
  }

  function stationChecklistKeys(key: string): string[] {
    if (key === 'cutting') return ['correct sheet size', 'correct board', 'count verified', 'edge quality ok']
    if (key === 'printing') return ['color approved', 'registration ok', 'shade card matched', 'print defects checked']
    if (key === 'chemical_coating' || key === 'lamination' || key === 'spot_uv') return ['coating type correct', 'gloss/matte checked', 'curing/drying ok']
    if (key === 'leafing' || key === 'embossing') return ['block/foil correct', 'pressure ok', 'registration ok']
    if (key === 'dye_cutting') return ['die correct', 'creasing ok', 'locking/flap alignment ok']
    if (key === 'pasting') return ['pasting type correct', 'glue strength ok', 'carton forming ok']
    if (key === 'sorting') return ['dimension ok', 'visual defects checked', 'quantity verified']
    return []
  }

  function statusClass(status: string): string {
    const s = status.toLowerCase()
    if (s === 'make_ready_alert') return 'bg-amber-900/30 text-amber-300 border-amber-600'
    if (s === 'make_ready_started') return 'bg-blue-900/40 text-blue-300 border-blue-600'
    if (s === 'ready_to_receive') return 'bg-cyan-900/40 text-cyan-300 border-cyan-600'
    if (s === 'partial_running') return 'bg-orange-900/40 text-orange-300 border-orange-600'
    if (s === 'in_progress') return 'bg-blue-900/40 text-blue-300 border-blue-600'
    if (s === 'completed') return 'bg-green-900/40 text-green-300 border-green-600'
    if (s === 'hold' || s === 'blocked') return 'bg-zinc-800 text-zinc-300 border-zinc-600'
    if (s === 'rework') return 'bg-rose-900/40 text-rose-300 border-rose-600'
    return 'bg-ds-elevated text-ds-ink-muted border-ds-line/60'
  }

  function previousRequiredStageKey(row: Payload['jobCards'][number]): string | null {
    const seq = requiredStageKeysForRow(row)
    const idx = seq.indexOf(stageKey)
    if (idx <= 0) return null
    return seq[idx - 1] ?? null
  }

  function getRowCounter(row: Payload['jobCards'][number]): string {
    const draft = counterDrafts[row.stageRecord.id]
    if (draft != null) return draft
    const v = row.stageRecord.counter
    return v != null ? String(v) : ''
  }

  function plannedQtyForRow(row: Payload['jobCards'][number]): number {
    const progress = getStageProgress(row)
    const fallback = stageKey === 'pasting' ? pastingExpectedCartons(row) : (row.jobCard.totalSheets || row.jobCard.requiredSheets || 0)
    return Math.max(0, Number(progress.plannedQty || fallback || 0))
  }

  function computeAutoFromCounter(row: Payload['jobCards'][number], counterRaw: string): { counter: number; wastage: number; pushQty: number } {
    const parsed = Number(counterRaw)
    const counter = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
    const planned = plannedQtyForRow(row)
    const progress = getStageProgress(row)
    const alreadyPushed = Math.max(0, Number(progress.pushedQty || 0))
    const wastage = Math.max(0, planned - counter)
    const pushQty = Math.max(0, counter - alreadyPushed)
    return { counter, wastage, pushQty }
  }

  function getRowOperator(row: Payload['jobCards'][number]): string {
    const draft = operatorDrafts[row.stageRecord.id]
    if (draft != null) return draft
    return row.stageRecord.operator ?? row.jobCard.shiftOperator?.name ?? ''
  }

  async function saveStageInline(
    row: Payload['jobCards'][number],
    opts?: {
      status?:
        | 'pending'
        | 'make_ready_alert'
        | 'make_ready_started'
        | 'ready_to_receive'
        | 'in_progress'
        | 'partial_running'
        | 'completed'
        | 'hold'
        | 'rework'
        | 'blocked'
      skipReload?: boolean
    },
  ) {
    if (opts?.status === 'in_progress' || opts?.status === 'partial_running') {
      const seq = requiredStageKeysForRow(row)
      const idx = seq.indexOf(stageKey)
      if (idx > 0) {
        const prevKey = seq[idx - 1]
        const prevLabel = stageLabelForKey(prevKey)
        const prev = row.jobCard.stageMap?.[prevLabel]
        const prevPushed = getStageProgress(row, prevKey).pushedQty
        if ((!prev || prev.status !== 'completed') && prevPushed <= 0) {
          toast.error('Previous station not completed.')
          return
        }
      }
    }
    const received = getUpstreamSheets(row)
    const rawCounter = getRowCounter(row).trim()
    const counter = rawCounter === '' ? null : Number(rawCounter)
    if (counter != null && (!Number.isFinite(counter) || counter < 0)) {
      toast.error('Actual counter must be a valid non-negative number')
      return
    }
    if (stageKey !== 'cutting' && counter != null && counter > 0 && (!Number.isFinite(received) || received <= 0)) {
      toast.error('Previous station not completed.')
      return
    }
    setSavingStageId(row.stageRecord.id)
    try {
      const payload: Record<string, unknown> = {
        stages: [
          {
            id: row.stageRecord.id,
            operator: getRowOperator(row).trim() || null,
            counter: counter != null ? Math.floor(counter) : null,
            ...(opts?.status ? { status: opts.status } : {}),
          },
        ],
      }
      if (opts?.status) {
        const postPress =
          row.jobCard.postPressRouting && typeof row.jobCard.postPressRouting === 'object'
            ? (row.jobCard.postPressRouting as Record<string, unknown>)
            : {}
        const ex = getExecutionState(row)
        const stageProgress =
          ex.stageProgress && typeof ex.stageProgress === 'object'
            ? (ex.stageProgress as Record<string, StageProgress>)
            : {}
        const current = stageProgress[stageKey] ?? getStageProgress(row)
        const nextKey = nextRequiredStageKey(row)
        const nowIso = new Date().toISOString()
        const nextProgress =
          nextKey != null
            ? stageProgress[nextKey] ?? { plannedQty: 0, completedQty: 0, pushedQty: 0, wastageQty: 0, status: 'pending' as const }
            : null
        const progressUpdate: Record<string, StageProgress> = {
          ...stageProgress,
          [stageKey]: {
            ...current,
            completedQty: counter != null ? Math.max(0, Math.floor(counter)) : Number(current.completedQty || 0),
            status: opts.status,
            expectedStartTime: current.expectedStartTime ?? nowIso,
          },
        }
        if ((opts.status === 'in_progress' || opts.status === 'partial_running') && nextKey && nextProgress) {
          const completedQty = counter != null ? Math.max(0, Math.floor(counter)) : Number(current.completedQty || 0)
          const plannedQty = Number(current.plannedQty || completedQty || 0)
          const remainingQty = Math.max(0, plannedQty - completedQty)
          const avgSpeedPerHour = Math.max(1, completedQty || 1)
          const etaHours = remainingQty > 0 ? remainingQty / avgSpeedPerHour : 0.5
          const eta = new Date(Date.now() + etaHours * 60 * 60 * 1000).toISOString()
          const nextStatus =
            String(nextProgress.status || 'pending').toLowerCase() === 'pending'
              ? 'make_ready_alert'
              : nextProgress.status
          progressUpdate[nextKey] = {
            ...nextProgress,
            status: nextStatus,
            expectedArrivalTime: eta,
            expectedStartTime: nextProgress.expectedStartTime ?? nowIso,
          }
        }
        payload.postPressRouting = {
          ...postPress,
          executionOrchestration: {
            ...ex,
            stageProgress: progressUpdate,
            stagePushTrail: [
              ...(Array.isArray(ex.stagePushTrail) ? ex.stagePushTrail : []),
              {
                at: nowIso,
                event: 'status_update',
                stage: stageKey,
                status: opts.status,
                jobCardId: row.jobCard.id,
                operator: getRowOperator(row).trim() || null,
              },
            ],
          },
        }
      }
      const res = await fetch(`/api/job-cards/${row.jobCard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(typeof json?.error === 'string' ? json.error : 'Failed to save stage update')
      }
      toast.success(opts?.status ? `Marked ${opts.status}` : 'Stage updated')
      if (!opts?.skipReload) await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save stage update')
    } finally {
      setSavingStageId(null)
    }
  }

  function pastingExpectedCartons(row: Payload['jobCards'][number]): number {
    const receivedSheets = getUpstreamSheets(row)
    const spec = row.jobCard.poMeta?.specOverrides ?? {}
    const planningCore =
      spec.planningCore && typeof spec.planningCore === 'object'
        ? (spec.planningCore as Record<string, unknown>)
        : {}
    const ups = Number((planningCore.ups as number | undefined) ?? 0) || 0
    return ups > 0 ? receivedSheets * ups : receivedSheets
  }

  function requiredStageKeysForRow(row: Payload['jobCards'][number]): string[] {
    const pp = row.jobCard.postPressRouting && typeof row.jobCard.postPressRouting === 'object'
      ? (row.jobCard.postPressRouting as Record<string, unknown>)
      : {}
    const out: string[] = ['cutting', 'printing']
    // Spot UV runs within coating, not as a standalone stage.
    if (pp.chemicalCoating === true || pp.spotUv === true) out.push('chemical_coating')
    if (pp.lamination === true) out.push('lamination')
    if (pp.leafing === true) out.push('leafing')
    if (pp.embossing === true) out.push('embossing')
    out.push('dye_cutting', 'pasting', 'sorting')
    return out
  }

  function nextRequiredStageKey(row: Payload['jobCards'][number]): string | null {
    const seq = requiredStageKeysForRow(row)
    const idx = seq.indexOf(stageKey)
    if (idx < 0 || idx >= seq.length - 1) return null
    return seq[idx + 1] ?? null
  }

  function nextStagePushSummary(row: Payload['jobCards'][number]): { label: string; qty: number; partial: boolean } | null {
    const nextKey = nextRequiredStageKey(row)
    if (!nextKey) return null
    const progress = getStageProgress(row)
    const pushedQty = Math.max(0, Number(progress.pushedQty || 0))
    if (pushedQty <= 0) return null
    const completedQty = Math.max(0, Number(getRowCounter(row) || progress.completedQty || 0))
    return {
      label: stageLabelForKey(nextKey),
      qty: pushedQty,
      partial: pushedQty < completedQty,
    }
  }

  function stageLabelForKey(key: string): string {
    return PRODUCTION_STAGES.find((s) => s.key === key)?.label ?? key
  }

  async function completeAndPushNext(row: Payload['jobCards'][number], skipReload = false) {
    return pushToNext(row, Number(getRowCounter(row) || 0), true, skipReload)
  }

  async function pushToNext(
    row: Payload['jobCards'][number],
    requestedPushQty: number,
    markCompleted: boolean,
    skipReload = false,
  ) {
    const nextKey = nextRequiredStageKey(row)
    if (!nextKey) {
      toast.error('No next station configured')
      return
    }
    const counter = Number(getRowCounter(row) || 0)
    const progress = getStageProgress(row)
    const completedQty = Number.isFinite(counter) ? Math.max(0, Math.floor(counter)) : progress.completedQty
    const alreadyPushedQty = Number(progress.pushedQty || 0)
    const pushQty = Math.floor(requestedPushQty)
    if (!Number.isFinite(pushQty) || pushQty <= 0) {
      toast.error('Push qty must be greater than 0')
      return
    }
    const availableToPush = Math.max(0, completedQty - alreadyPushedQty)
    if (pushQty > availableToPush) {
      toast.error(`Push qty cannot exceed available output (${availableToPush})`)
      return
    }
    const checklist = checklistDrafts[row.stageRecord.id] ?? {}
    const requiredChecklist = stationChecklistKeys(stageKey)
    const allChecked = requiredChecklist.every((k) => checklist[k] === true)
    if (markCompleted && requiredChecklist.length > 0 && !allChecked) {
      toast.error('Complete required quality checklist before push')
      return
    }
    const approvalEnabled = getExecutionState(row).supervisorApprovalEnabled === true
    if (approvalEnabled && progress.approvalStatus !== 'approved') {
      toast.error('Supervisor approval required before push')
      return
    }
    const stages = row.jobCard.stageMap ?? {}
    const nextLabel = stageLabelForKey(nextKey)
    const nextStage = stages[nextLabel]
    const nextStatus = nextStage?.status ?? 'pending'
    if (nextStage?.id && (nextStatus === 'in_progress' || nextStatus === 'completed')) {
      toast.error('Next station already started. Reopen requires admin override.')
      return
    }
    setSavingStageId(row.stageRecord.id)
    try {
      const postPress = row.jobCard.postPressRouting && typeof row.jobCard.postPressRouting === 'object'
        ? (row.jobCard.postPressRouting as Record<string, unknown>)
        : {}
      const execution =
        postPress.executionOrchestration && typeof postPress.executionOrchestration === 'object'
          ? (postPress.executionOrchestration as Record<string, unknown>)
          : {}
      const transitionTrail = Array.isArray(execution.stagePushTrail)
        ? (execution.stagePushTrail as unknown[])
        : []
      const triageByStage =
        execution.triageByStage && typeof execution.triageByStage === 'object'
          ? (execution.triageByStage as Record<string, unknown>)
          : {}
      const downtimeLogs = Array.isArray(execution.downtimeLogs) ? execution.downtimeLogs : []
      const reworkTrail = Array.isArray(execution.reworkTrail) ? execution.reworkTrail : []
      const stageProgress = execution.stageProgress && typeof execution.stageProgress === 'object'
        ? (execution.stageProgress as Record<string, StageProgress>)
        : {}
      const thisStage = stageProgress[stageKey] ?? progress
      const nextStageProgress = stageProgress[nextKey] ?? {
        plannedQty: 0,
        completedQty: 0,
        pushedQty: 0,
        wastageQty: 0,
      }
      const auto = computeAutoFromCounter(row, getRowCounter(row))
      const wastageQty = Number(wastageDrafts[row.stageRecord.id] ?? auto.wastage ?? thisStage.wastageQty ?? 0) || 0
      const updatedCompleted = completedQty
      const updatedPushed = alreadyPushedQty + pushQty
      const plannedQty = thisStage.plannedQty || (stageKey === 'pasting' ? pastingExpectedCartons(row) : row.jobCard.totalSheets || 0)
      const stationFinished = markCompleted && updatedPushed >= plannedQty

      const token = nextKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      const queuedField = `${token}QueuedAt`
      const bundleNo = `BND-${row.jobCard.jobCardNumber}-${stageKey}-${Date.now().toString().slice(-6)}`
      const stagePayload = [
        {
          id: row.stageRecord.id,
          operator: getRowOperator(row).trim() || null,
          counter: updatedCompleted,
          status: stationFinished ? 'completed' : 'in_progress',
        },
      ] as Array<Record<string, unknown>>
      stagePayload.push(
        nextStage?.id
          ? {
              id: nextStage.id,
              status: 'pending',
            }
          : {
              stageName: nextLabel,
              status: 'pending',
            },
      )
      const nextStageTriage =
        triageByStage[nextKey] && typeof triageByStage[nextKey] === 'object'
          ? (triageByStage[nextKey] as Record<string, unknown>)
          : {}
      const nextTriageKey = nextStage?.id ?? `${row.jobCard.id}:${nextKey}`
      const existingNextTriageCard =
        nextStageTriage[nextTriageKey] && typeof nextStageTriage[nextTriageKey] === 'object'
          ? (nextStageTriage[nextTriageKey] as Record<string, unknown>)
          : {}
      const thisApproval = approvalEnabled ? (thisStage.approvalStatus ?? 'pending') : 'approved'
      const res = await fetch(`/api/job-cards/${row.jobCard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postPressRouting: {
            ...postPress,
            executionOrchestration: {
              ...execution,
              [queuedField]: new Date().toISOString(),
              stageProgress: {
                ...stageProgress,
                [stageKey]: {
                  ...thisStage,
                  plannedQty,
                  completedQty: updatedCompleted,
                  pushedQty: updatedPushed,
                  wastageQty,
                  approvalStatus: thisApproval,
                  completedBy: getRowOperator(row).trim() || null,
                  completedAt: new Date().toISOString(),
                },
                [nextKey]: {
                  ...nextStageProgress,
                  status:
                    updatedPushed > 0 && updatedPushed < plannedQty
                      ? 'partial_running'
                      : (nextStageProgress.status === 'in_progress' || nextStageProgress.status === 'completed'
                          ? nextStageProgress.status
                          : 'ready_to_receive'),
                  plannedQty: Number(nextStageProgress.plannedQty || 0) + pushQty,
                },
              },
              triageByStage: {
                ...triageByStage,
                [nextKey]: {
                  ...nextStageTriage,
                  [nextTriageKey]: {
                    ...existingNextTriageCard,
                    status:
                      updatedPushed > 0 && updatedPushed < plannedQty
                        ? 'partial_running'
                        : String(existingNextTriageCard.status === 'in_progress' || existingNextTriageCard.status === 'completed'
                            ? existingNextTriageCard.status
                            : 'ready_to_receive'),
                    sequenceNo: Number(existingNextTriageCard.sequenceNo ?? 9999),
                    priorityRank: Number(existingNextTriageCard.priorityRank ?? (row.jobCard.industrialPriority ? 1 : 100)),
                    expectedArrivalTime: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                },
              },
              checklistByStage: {
                ...(execution.checklistByStage && typeof execution.checklistByStage === 'object'
                  ? execution.checklistByStage
                  : {}),
                [stageKey]: checklist,
              },
              stagePushTrail: [
                ...transitionTrail,
                {
                  fromStage: label,
                  toStage: nextLabel,
                  jobCardId: row.jobCard.id,
                  qtyTransferred: pushQty,
                  operator: getRowOperator(row).trim() || null,
                  at: new Date().toISOString(),
                  remarks: null,
                  bundleNo,
                  pushType: stationFinished ? 'complete' : 'partial',
                },
              ],
              downtimeLogs,
              reworkTrail,
            },
          },
          stages: stagePayload,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : 'Failed to push next stage')
      toast.success(`${stationFinished ? 'Completed' : 'Partially pushed'} ${label} → ${nextLabel} (${pushQty})`)
      if (!skipReload) await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to push next stage')
    } finally {
      setSavingStageId(null)
    }
  }

  async function setApproval(
    row: Payload['jobCards'][number],
    decision: 'approved' | 'rejected',
    remarks?: string | null,
  ) {
    const ex = getExecutionState(row)
    const stageProgress = ex.stageProgress && typeof ex.stageProgress === 'object'
      ? (ex.stageProgress as Record<string, StageProgress>)
      : {}
    const current = stageProgress[stageKey] ?? getStageProgress(row)
    const res = await fetch(`/api/job-cards/${row.jobCard.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postPressRouting: {
          ...(row.jobCard.postPressRouting && typeof row.jobCard.postPressRouting === 'object'
            ? row.jobCard.postPressRouting
            : {}),
          executionOrchestration: {
            ...ex,
            stageProgress: {
              ...stageProgress,
              [stageKey]: {
                ...current,
                approvalStatus: decision,
                approvedBy: getRowOperator(row).trim() || null,
                approvedAt: new Date().toISOString(),
                approvalRemarks: remarks ?? null,
              },
            },
            stagePushTrail: [
              ...(Array.isArray(ex.stagePushTrail) ? ex.stagePushTrail : []),
              {
                at: new Date().toISOString(),
                event: decision === 'approved' ? 'supervisor_approved' : 'supervisor_rejected',
                stage: stageKey,
                jobCardId: row.jobCard.id,
                operator: getRowOperator(row).trim() || null,
                remarks: remarks ?? null,
              },
            ],
          },
        },
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(typeof json?.error === 'string' ? json.error : 'Failed to update approval')
      return
    }
    toast.success(decision === 'approved' ? 'Supervisor approved' : 'Supervisor rejected')
    await load()
  }

  async function sendRework(row: Payload['jobCards'][number], skipReload = false) {
    const seq = requiredStageKeysForRow(row)
    const idx = seq.indexOf(stageKey)
    if (idx <= 0) {
      toast.error('No previous stage available for rework')
      return
    }
    const targetKey = seq[idx - 1]!
    const targetLabel = stageLabelForKey(targetKey)
    const qty = Number(prompt('Rework qty to send back:', '0') ?? 0)
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Invalid rework qty')
      return
    }
    const reason = (prompt('Rework reason:', '') ?? '').trim()
    if (!reason) {
      toast.error('Rework reason is required')
      return
    }
    const stages = row.jobCard.stageMap ?? {}
    const targetStage = stages[targetLabel]
    if (!targetStage?.id) {
      toast.error(`Target stage not found: ${targetLabel}`)
      return
    }
    const ex = getExecutionState(row)
    const stageProgress = ex.stageProgress && typeof ex.stageProgress === 'object'
      ? (ex.stageProgress as Record<string, StageProgress>)
      : {}
    const current = stageProgress[stageKey] ?? getStageProgress(row)
    const available = Math.max(0, Number(current.completedQty || 0) - Number(current.wastageQty || 0))
    if (qty > available) {
      toast.error(`Rework qty cannot exceed available qty (${available})`)
      return
    }
    const reworkTrail = Array.isArray(ex.reworkTrail) ? ex.reworkTrail : []
    const res = await fetch(`/api/job-cards/${row.jobCard.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postPressRouting: {
          ...(row.jobCard.postPressRouting && typeof row.jobCard.postPressRouting === 'object'
            ? row.jobCard.postPressRouting
            : {}),
          executionOrchestration: {
            ...ex,
            stageProgress: {
              ...stageProgress,
              [stageKey]: { ...current, completedQty: Math.max(0, available - qty), approvalStatus: 'rejected' },
              [targetKey]: {
                ...(stageProgress[targetKey] ?? { plannedQty: 0, completedQty: 0, pushedQty: 0, wastageQty: 0 }),
                plannedQty: Number((stageProgress[targetKey]?.plannedQty ?? 0) + qty),
              },
            },
            reworkTrail: [
              ...reworkTrail,
              {
                at: new Date().toISOString(),
                fromStage: stageKey,
                toStage: targetKey,
                qty,
                reason,
                jobCardId: row.jobCard.id,
              },
            ],
          },
        },
        stages: [
          { id: row.stageRecord.id, status: 'rework' },
          { id: targetStage.id, status: 'pending' },
        ],
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(typeof json?.error === 'string' ? json.error : 'Failed to send rework')
      return
    }
    toast.success(`Sent ${qty} to ${targetLabel} for rework`)
    if (!skipReload) await load()
  }

  async function bringBackFromNextStage(row: Payload['jobCards'][number], skipReload = false) {
    const nextKey = nextRequiredStageKey(row)
    if (!nextKey) {
      toast.error('No next stage configured')
      return
    }
    const nextLabel = stageLabelForKey(nextKey)
    const nextStage = row.jobCard.stageMap?.[nextLabel]
    if (!nextStage?.id) {
      toast.error(`Next stage record missing: ${nextLabel}`)
      return
    }
    if (nextStage.status === 'in_progress' || nextStage.status === 'completed') {
      toast.error(`Cannot bring back. ${nextLabel} already started.`)
      return
    }
    setSavingStageId(row.stageRecord.id)
    try {
      const res = await fetch(`/api/production/stages/${nextKey}/controls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reverse_row_stage',
          stageRecordId: nextStage.id,
          confirm: true,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(typeof json?.error === 'string' ? json.error : 'Failed to bring back from next stage')
      }
      toast.success(`Brought back from ${nextLabel}`)
      if (!skipReload) await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to bring back from next stage')
    } finally {
      setSavingStageId(null)
    }
  }

  async function runStageControlAction(payload: Record<string, unknown>) {
    setBulkBusy(true)
    try {
      const res = await fetch(`/api/production/stages/${stageKey}/controls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(typeof json?.error === 'string' ? json.error : 'Action failed')
      }
      return json
    } finally {
      setBulkBusy(false)
    }
  }

  async function bulkDeleteFromStage() {
    if (selectedStageRecordIds.size === 0) {
      toast.error('Select rows to delete from this stage queue')
      return
    }
    const token = prompt('Type DELETE to confirm bulk delete from this stage queue')
    if (token !== 'DELETE') return
    try {
      const json = await runStageControlAction({
        action: 'bulk_delete_from_stage',
        confirm: true,
        stageRecordIds: Array.from(selectedStageRecordIds),
      })
      toast.success(`Deleted ${Number((json as { deleted?: number }).deleted ?? 0)} row(s) from queue`)
      setSelectedStageRecordIds(new Set())
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete rows')
    }
  }

  async function clearFromCurrentStageOnward() {
    const token = prompt(`Type RESET to clear live-production data from ${label} onward`)
    if (token !== 'RESET') return
    try {
      const json = await runStageControlAction({
        action: 'bulk_reset_from_stage',
        confirm: true,
        stageRecordIds: selectedStageRecordIds.size > 0 ? Array.from(selectedStageRecordIds) : undefined,
      })
      toast.success(`Reset ${Number((json as { resetJobs?: number }).resetJobs ?? 0)} job(s) from ${label} onward`)
      setSelectedStageRecordIds(new Set())
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to clear stage data')
    }
  }

  async function reverseRowStage(row: Payload['jobCards'][number]) {
    try {
      const json = await runStageControlAction({
        action: 'reverse_row_stage',
        confirm: true,
        stageRecordId: row.stageRecord.id,
      })
      toast.success(`Moved back to ${String((json as { movedTo?: string }).movedTo ?? 'previous stage')}`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reverse row')
    }
  }

  async function deleteRowFromStage(row: Payload['jobCards'][number]) {
    const ok = window.confirm(`Delete JC-${row.jobCard.jobCardNumber} from ${label} queue?`)
    if (!ok) return
    const reason = window.prompt('Delete reason (required):', '')?.trim() ?? ''
    if (reason.length < 3) {
      toast.error('Delete reason is required (min 3 characters)')
      return
    }
    const token = window.prompt('Type DELETE to confirm row delete', '')?.trim() ?? ''
    if (token !== 'DELETE') return
    try {
      const json = await runStageControlAction({
        action: 'bulk_delete_from_stage',
        confirm: true,
        stageRecordIds: [row.stageRecord.id],
        reason,
      })
      const deleted = Number((json as { deleted?: number }).deleted ?? 0)
      toast.success(`Deleted ${deleted > 0 ? deleted : 1} row from queue`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete row')
    }
  }

  async function runBulkAction(
    label: string,
    fn: (row: Payload['jobCards'][number]) => Promise<void>,
  ) {
    const targets = visibleList.filter((r) => selectedStageRecordIds.has(r.stageRecord.id))
    if (targets.length === 0) {
      toast.error('Select at least one row')
      return
    }
    setBulkBusy(true)
    try {
      for (const row of targets) {
        await fn(row)
      }
      toast.success(`${label} done for ${targets.length} row(s)`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed: ${label}`)
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <>
    <IndustrialModuleShell
      title={label}
      subtitle={
        `${stageKpis.total} job card${stageKpis.total !== 1 ? 's' : ''} at this stage` +
        (['chemical_coating', 'lamination', 'spot_uv', 'leafing', 'embossing'].includes(stageKey)
          ? ' · Filtered by post-press routing'
          : '')
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            href="/production/stages"
            className="text-sm text-ds-ink-muted hover:text-foreground"
          >
            ← All stages
          </Link>
          <Link
            href={`/production/stages/${stageKey}/triage`}
            className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm hover:bg-ds-card"
          >
            Open Triage
          </Link>
        </div>
        <Link
          href="/production/job-cards"
          className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm hover:bg-ds-card"
        >
          Job Cards
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['pending', 'make_ready', 'running', 'hold', 'completed'] as const).map((t) => {
          const count = list.filter((row) => {
            const s = String(getStageProgress(row).status ?? row.stageRecord.status ?? 'pending').toLowerCase()
            if (t === 'pending') return s === 'pending'
            if (t === 'make_ready') return s === 'make_ready_alert' || s === 'make_ready_started' || s === 'ready_to_receive'
            if (t === 'running') return s === 'in_progress' || s === 'partial_running' || s === 'rework'
            if (t === 'hold') return s === 'hold' || s === 'blocked'
            return s === 'completed'
          }).length
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-full border px-3 py-1 text-xs ${tab === t ? 'border-ds-warning text-ds-warning bg-ds-warning/10' : 'border-ds-line/60 text-ds-ink-muted hover:bg-ds-card'}`}
            >
              {t.replace('_', ' ')}: {count}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ds-ink-faint">Selected: {selectedCount}</span>
        <button
          type="button"
          disabled={bulkBusy || visibleList.length === 0}
          onClick={() => selectAllInCurrentTab()}
          className="rounded border border-ds-line/60 px-2 py-1 text-xs text-ds-ink-muted hover:bg-ds-card disabled:opacity-50"
        >
          Select All (Tab)
        </button>
        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0}
          onClick={() =>
            void runBulkAction('Bulk Start', async (row) => {
              await saveStageInline(row, { status: 'in_progress', skipReload: true })
            })
          }
          className="rounded border border-blue-600/40 px-2 py-1 text-xs text-blue-600 hover:bg-blue-500/10 disabled:opacity-50"
        >
          Bulk Start
        </button>
        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0}
          onClick={() =>
            void runBulkAction('Bulk Partial Push', async (row) => {
              const progress = getStageProgress(row)
              const completedQty = Number(getRowCounter(row) || progress.completedQty || 0)
              const pushQty = Math.max(0, completedQty - Number(progress.pushedQty || 0))
              if (pushQty > 0) await pushToNext(row, pushQty, false, true)
            })
          }
          className="rounded border border-amber-600/40 px-2 py-1 text-xs text-ds-warning hover:bg-ds-warning/10 disabled:opacity-50"
        >
          Bulk Partial Push
        </button>
        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0}
          onClick={() =>
            void runBulkAction('Bulk Complete Push', async (row) => {
              await completeAndPushNext(row, true)
            })
          }
          className="rounded border border-emerald-600/40 px-2 py-1 text-xs text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          Bulk Complete
        </button>
        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0}
          onClick={() =>
            void runBulkAction('Bulk Undo Push', async (row) => {
              await bringBackFromNextStage(row, true)
            })
          }
          className="rounded border border-blue-500/40 px-2 py-1 text-xs text-blue-600 hover:bg-blue-500/10 disabled:opacity-50"
        >
          Bulk Undo
        </button>
        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0}
          onClick={() =>
            void runBulkAction('Bulk Rework Mark', async (row) => {
              await saveStageInline(row, { status: 'rework', skipReload: true })
            })
          }
          className="rounded border border-rose-600/40 px-2 py-1 text-xs text-rose-600 hover:bg-rose-500/10 disabled:opacity-50"
        >
          Bulk Rework
        </button>
        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0}
          onClick={() => void bulkDeleteFromStage()}
          className="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-600 hover:bg-rose-500/10 disabled:opacity-50"
        >
          {bulkBusy ? 'Working…' : 'Bulk Delete'}
        </button>
        <button
          type="button"
          disabled={bulkBusy}
          onClick={() => void clearFromCurrentStageOnward()}
          className="rounded border border-ds-warning/40 px-2 py-1 text-xs text-ds-warning hover:bg-ds-warning/10 disabled:opacity-50"
        >
          Clear from {label} onward
        </button>
        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0}
          onClick={() => setSelectedStageRecordIds(new Set())}
          className="rounded border border-ds-line/60 px-2 py-1 text-xs text-ds-ink-muted hover:bg-ds-card disabled:opacity-50"
        >
          Clear Selection
        </button>
      </div>

      <div className={industrialTableClassName()}>
        <table className="w-full text-sm text-left border-collapse">
          <thead className="bg-ds-main/90 text-ds-ink-muted border-b border-ds-line/40">
            <tr>
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={(e) => toggleVisibleSelection(e.target.checked)}
                  aria-label="Select visible rows"
                />
              </th>
              <th className="px-3 py-2">Operator</th>
              <th className="px-3 py-2">Machine No.</th>
              <SortHeader columnKey="jobCardNumber">Job Card No.</SortHeader>
              <SortHeader columnKey="productName">Product / Carton Details</SortHeader>
              <th className="px-3 py-2">Set No.</th>
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2">Input / Parent</th>
              <th className="px-3 py-2">Sheet / Cut</th>
              <th className="px-3 py-2">Required</th>
              <th className="px-3 py-2">Actual Counter</th>
              <th className="px-3 py-2">Status</th>
              <SortHeader columnKey="completedAt">Completed At</SortHeader>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ds-line/30">
            {visibleList.map((row) => {
              const { stageRecord, jobCard } = row
              const received = getUpstreamSheets(row)
              const actual = Number(getRowCounter(row) || 0)
              const poMeta = jobCard.poMeta ?? null
              const spec = (poMeta?.specOverrides as Record<string, unknown> | null) ?? null
              const planningCore =
                spec?.planningCore && typeof spec.planningCore === 'object'
                  ? (spec.planningCore as Record<string, unknown>)
                  : {}
              const cutSize =
                typeof planningCore.sheetSize === 'string' && planningCore.sheetSize.trim()
                  ? planningCore.sheetSize.trim()
                  : poMeta?.cartonSize ?? '—'
              const ups = Number((planningCore.ups as number | undefined) ?? 0) || 0
              const expectedCartons = stageKey === 'pasting' ? pastingExpectedCartons(row) : null
              const defaultRequired =
                stageKey === 'pasting'
                  ? expectedCartons ?? jobCard.totalSheets
                  : (stageKey === 'printing' ? received : jobCard.totalSheets)
              const progress = getStageProgress(row)
              const triage = getTriageMeta(row)
              const completedQty = Number(getRowCounter(row) || progress.completedQty || 0)
              const alreadyPushedQty = Number(progress.pushedQty || 0)
              const availableToPush = Math.max(0, completedQty - alreadyPushedQty)
              const pushDraft = pushDrafts[stageRecord.id]
              const currentPushQty = pushDraft == null || pushDraft === '' ? availableToPush : Number(pushDraft)
              const supervisorApprovalEnabled = getExecutionState(row).supervisorApprovalEnabled === true
              const balance =
                stageKey === 'pasting'
                  ? (expectedCartons ?? 0) - actual
                  : received - actual

              const nextKey = nextRequiredStageKey(row)
              const nextLabel = nextKey ? stageLabelForKey(nextKey) : null
              const nextStageState = nextLabel ? row.jobCard.stageMap?.[nextLabel] : null
              const nextStarted = nextStageState?.status === 'in_progress' || nextStageState?.status === 'completed'
              const pushSummary = nextStagePushSummary(row)
              const pushedForTracking = stickyPushTrackingEnabled && alreadyPushedQty > 0
              return (
                <tr
                  key={stageRecord.id}
                  className={`hover:bg-ds-card/50 cursor-pointer ${(String(progress.status ?? stageRecord.status ?? '').toLowerCase() === 'completed' || pushedForTracking) ? 'bg-emerald-500/10' : ''}`}
                  onClick={() => setSpotlight(row)}
                >
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedStageRecordIds.has(stageRecord.id)}
                      onChange={(e) => toggleRowSelection(stageRecord.id, e.target.checked)}
                      aria-label={`Select row ${stageRecord.id}`}
                    />
                  </td>
                  <td className="px-3 py-2">{getRowOperator(row) || '—'}</td>
                  <td className="px-3 py-2">{jobCard.machine?.machineCode ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-ds-warning">{jobCard.jobCardNumber}</td>
                  <td className="px-3 py-2">
                    <div className="text-ds-ink">{jobCard.productName ?? poMeta?.cartonName ?? '—'}</div>
                    <div className="text-xs text-ds-ink-faint">
                      PO {poMeta?.poNumber ?? '—'} · Qty {Number(poMeta?.quantity ?? 0).toLocaleString('en-IN')}
                    </div>
                  </td>
                  <td className="px-3 py-2">{jobCard.setNumber ?? '—'}</td>
                  <td className="px-3 py-2">{jobCard.customer.name}</td>
                  <td className="px-3 py-2">
                    {stageKey === 'cutting' ? (
                      <span>{poMeta?.paperType ?? '—'}</span>
                    ) : (
                      <span>{Number(received).toLocaleString('en-IN')}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div>{cutSize}</div>
                    <div className="text-xs text-ds-ink-faint">
                      {stageKey === 'cutting' || stageKey === 'pasting'
                        ? `UPS ${ups || '—'}`
                        : `GSM ${poMeta?.gsm ?? '—'}`}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {Number(defaultRequired).toLocaleString('en-IN')}
                    {stageKey === 'pasting' ? (
                      <span className="ml-1 text-xs text-ds-ink-faint">cartons</span>
                    ) : (
                      <span className="ml-1 text-xs text-ds-ink-faint">sheets</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`${mono}`}>{Number(getRowCounter(row) || 0).toLocaleString('en-IN')}</span>
                    <div className="text-[11px] text-ds-ink-faint mt-1">
                      Pushed: {alreadyPushedQty.toLocaleString('en-IN')} · {stageKey === 'pasting' ? 'Short/Excess' : 'Balance'}: {Number(balance).toLocaleString('en-IN')}
                    </div>
                    <div className="mt-1 text-[11px] text-ds-ink-faint">Open drawer for push qty and execution decisions.</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs border ${statusClass(String(progress.status ?? stageRecord.status ?? 'pending'))}`}>
                      {supervisorApprovalEnabled && progress.approvalStatus === 'pending'
                        ? 'pending_approval'
                        : String(progress.status ?? stageRecord.status ?? 'pending')}
                    </span>
                    {alreadyPushedQty > 0 && alreadyPushedQty < completedQty ? (
                      <span className="ml-1 px-2 py-0.5 rounded text-[10px] border border-amber-500/60 text-amber-300 bg-amber-900/25">
                        partially_pushed
                      </span>
                    ) : null}
                    {pushSummary ? (
                      <div className="mt-1 text-[11px] text-emerald-600">
                        {pushSummary.partial ? 'Partially pushed' : 'Pushed'} to next stage ({pushSummary.label}):{' '}
                        {pushSummary.qty.toLocaleString('en-IN')}
                      </div>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="rounded-full border border-ds-line/60 px-1.5 py-0.5 text-[10px] text-ds-ink-faint">Queue #{triage.sequenceNo}</span>
                      <span className="rounded-full border border-ds-line/60 px-1.5 py-0.5 text-[10px] text-ds-ink-faint">Slot {triage.plannedStartTs === Number.MAX_SAFE_INTEGER ? '-' : new Date(triage.plannedStartTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-ds-ink-muted">
                    {stageRecord.completedAt ? new Date(stageRecord.completedAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSpotlight(row)}
                        className="rounded border border-ds-warning/50 px-2 py-1 text-xs text-ds-warning hover:bg-ds-warning/10"
                      >
                        Open Decisions
                      </button>
                      <button
                        type="button"
                        disabled={bulkBusy}
                        onClick={() => void reverseRowStage(row)}
                        className="rounded border border-blue-500/40 px-2 py-1 text-xs text-blue-600 hover:bg-blue-500/10 disabled:opacity-50"
                      >
                        Reverse
                      </button>
                      <button
                        type="button"
                        disabled={bulkBusy}
                        onClick={() => void deleteRowFromStage(row)}
                        className="rounded border border-rose-600/40 px-2 py-1 text-xs text-rose-600 hover:bg-rose-500/10 disabled:opacity-50"
                      >
                        Delete
                      </button>
                      <Link href={`/production/job-cards/${jobCard.id}`} className="rounded border border-ds-line/50 px-2 py-1 text-xs text-ds-warning hover:bg-ds-main">
                        Open
                      </Link>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {stageKey === 'dye_cutting' && list.some((x) => x.stageRecord.status === 'completed') ? (
        <div className="rounded-xl border border-ds-warning/50 bg-ds-warning/10 p-4">
          <p className="text-ds-warning font-medium">⚠ DIE RETURN REQUIRED</p>
          <p className="text-xs text-ds-warning mt-1">
            Die Cutting completed jobs should return dies immediately with run impressions and condition.
          </p>
          <p className="text-xs text-ds-ink-muted mt-2">
            Open the job card, use the Die panel, then click <span className="font-semibold">Confirm Return</span>.
          </p>
        </div>
      ) : null}

      {stageKey === 'embossing' && list.some((x) => x.stageRecord.status === 'completed') ? (
        <div className="rounded-xl border border-ds-warning/50 bg-ds-warning/10 p-4">
          <p className="text-ds-warning font-medium">⚠ EMBOSS BLOCK RETURN REQUIRED</p>
          <p className="text-xs text-ds-warning mt-1">
            Embossing completed jobs should return blocks immediately with impressions and condition.
          </p>
          <p className="text-xs text-ds-ink-muted mt-2">
            Open the job card and complete block return from the Emboss Block panel.
          </p>
        </div>
      ) : null}

      {visibleList.length === 0 && (
        <p className="text-ds-ink-faint text-center py-8 text-sm">
          No job cards in this queue tab.
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
        <div className="space-y-4 text-sm text-ds-ink-muted">
          {spotlight.jobCard.oee ? (
            <>
              <p className={`${mono} text-2xl ${oeeBandClass(spotlight.jobCard.oee.oee)}`}>
                OEE {spotlight.jobCard.oee.oee}%
              </p>
              <div className={`grid grid-cols-3 gap-2 text-xs ${mono}`}>
                <div>
                  <div className="text-ds-ink-faint">A</div>
                  <div className="text-ds-ink">{spotlight.jobCard.oee.availability}%</div>
                </div>
                <div>
                  <div className="text-ds-ink-faint">P</div>
                  <div className="text-ds-ink">{spotlight.jobCard.oee.performance}%</div>
                </div>
                <div>
                  <div className="text-ds-ink-faint">Q</div>
                  <div className="text-ds-ink">{spotlight.jobCard.oee.quality}%</div>
                </div>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-ds-ink-faint mb-1">
                  Live speedometer (sheets/h)
                </p>
                <div className="h-3 w-full rounded-full bg-ds-card border border-ds-line/40 overflow-hidden">
                  <div
                    className="h-full bg-[var(--warning)] transition-all duration-500"
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
                <p className={`mt-1 ${mono} text-ds-ink`}>
                  {spotlight.jobCard.oee.currentSpeedPph} / {Math.round(spotlight.jobCard.oee.ratedSpeedPph)} sh/h
                  <span className="text-ds-ink-faint ml-2">limit</span>
                </p>
              </div>
              {spotlight.jobCard.machine ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xs text-ds-ink-faint">
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
            <p className="text-ds-ink-faint text-sm">No live OEE for this row (start stage to see metrics).</p>
          )}
          {spotlight.jobCard.incentiveLedger?.incentiveEligible ? (
            <div className="flex items-start gap-3 rounded-lg border border-emerald-500/50 bg-emerald-950/25 px-3 py-3">
              <CircleDollarSign className="h-7 w-7 text-emerald-500 shrink-0" strokeWidth={1.75} />
              <div className="space-y-1">
                <p className="text-emerald-400 text-xs font-semibold uppercase tracking-wide">
                  Incentive earned
                </p>
                <p className={`text-xs text-ds-ink-muted ${mono}`}>
                  Ledger yield {spotlight.jobCard.incentiveLedger.yieldPercent ?? '—'}% · OEE{' '}
                  {spotlight.jobCard.incentiveLedger.oeePct}%
                </p>
                {spotlight.jobCard.incentiveLedger.incentiveVerifiedAt ? (
                  <p className="text-emerald-600 text-xs">Performance incentive verified</p>
                ) : (
                  <button
                    type="button"
                    disabled={incentiveBusy}
                    onClick={() => void verifyPerformanceIncentive(spotlight.jobCard.id)}
                    className="mt-1 px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-primary-foreground text-xs font-medium disabled:opacity-50"
                  >
                    {incentiveBusy ? '…' : 'Verify performance incentive'}
                  </button>
                )}
              </div>
            </div>
          ) : null}
          {(() => {
            const row = spotlight
            const progress = getStageProgress(row)
            const currentStatus = String(progress.status ?? row.stageRecord.status ?? 'pending').toLowerCase()
            const completedQty = Number(getRowCounter(row) || progress.completedQty || 0)
            const pushedQty = Number(progress.pushedQty || 0)
            const availableToPush = Math.max(0, completedQty - pushedQty)
            const autoFromCounter = computeAutoFromCounter(row, getRowCounter(row))
            const pushDraft = pushDrafts[row.stageRecord.id]
            const pushQty = pushDraft == null || pushDraft === '' ? autoFromCounter.pushQty : Number(pushDraft)
            const supervisorApprovalEnabled = getExecutionState(row).supervisorApprovalEnabled === true
            const nextKey = nextRequiredStageKey(row)
            const nextLabel = nextKey ? stageLabelForKey(nextKey) : null
            const nextStageState = nextLabel ? row.jobCard.stageMap?.[nextLabel] : null
            const nextStarted = nextStageState?.status === 'in_progress' || nextStageState?.status === 'completed'

            return (
              <div className="rounded-lg border border-ds-line/50 bg-ds-main px-3 py-3">
                <p className="text-xs uppercase tracking-wide text-ds-ink-faint mb-2">{stageMeta?.label ?? 'Stage'} decisions</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <label className="space-y-1">
                    <span className="text-ds-ink-faint">Operator</span>
                    <input
                      value={getRowOperator(row)}
                      onChange={(e) => setOperatorDrafts((prev) => ({ ...prev, [row.stageRecord.id]: e.target.value }))}
                      className="w-full rounded border border-ds-line/50 bg-ds-card px-2 py-1 text-xs text-ds-ink"
                      placeholder="Operator"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-ds-ink-faint">Actual Counter</span>
                    <input
                      value={getRowCounter(row)}
                      onChange={(e) => {
                        const nextRaw = e.target.value
                        setCounterDrafts((prev) => ({ ...prev, [row.stageRecord.id]: nextRaw }))
                        const auto = computeAutoFromCounter(row, nextRaw)
                        setPushDrafts((prev) => ({ ...prev, [row.stageRecord.id]: String(auto.pushQty) }))
                        setWastageDrafts((prev) => ({ ...prev, [row.stageRecord.id]: String(auto.wastage) }))
                      }}
                      className={`w-full rounded border border-ds-line/50 bg-ds-card px-2 py-1 text-right text-xs text-ds-ink ${mono}`}
                      placeholder="0"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-ds-ink-faint">Push Qty</span>
                    <input
                      value={pushDrafts[row.stageRecord.id] ?? String(autoFromCounter.pushQty)}
                      onChange={(e) => setPushDrafts((prev) => ({ ...prev, [row.stageRecord.id]: e.target.value }))}
                      className={`w-full rounded border border-ds-line/50 bg-ds-card px-2 py-1 text-right text-xs text-ds-ink ${mono}`}
                      placeholder={String(autoFromCounter.pushQty)}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-ds-ink-faint">Wastage Qty</span>
                    <input
                      value={wastageDrafts[row.stageRecord.id] ?? String(computeAutoFromCounter(row, getRowCounter(row)).wastage)}
                      readOnly
                      className={`w-full rounded border border-ds-line/50 bg-ds-card px-2 py-1 text-right text-xs text-ds-ink ${mono}`}
                      placeholder="0"
                    />
                  </label>
                </div>
                <p className="mt-2 text-[11px] text-ds-ink-faint">
                  Status: <span className="text-ds-ink">{currentStatus}</span> · Available to push: <span className={mono}>{availableToPush.toLocaleString('en-IN')}</span>
                </p>
                {nextLabel ? <p className="text-[11px] text-ds-ink-faint">Next stage: {nextLabel}</p> : null}
                {nextLabel && completedQty > 0 && availableToPush === 0 && pushedQty > 0 ? (
                  <div className="mt-1 flex items-center gap-2">
                    <p className="text-[11px] text-emerald-600">
                      Already pushed to next stage ({nextLabel}): {pushedQty.toLocaleString('en-IN')}
                    </p>
                    <button
                      type="button"
                      disabled={savingStageId === row.stageRecord.id}
                      onClick={() => void bringBackFromNextStage(row)}
                      className="rounded border border-blue-600/40 px-2 py-0.5 text-[11px] text-blue-600 hover:bg-blue-500/10 disabled:opacity-50"
                    >
                      Undo Last Push
                    </button>
                  </div>
                ) : null}
                <div className="mt-3 sticky top-0 z-10 rounded-md border border-ds-line/40 bg-ds-main/95 p-2">
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-ds-ink-faint">Quick Actions</p>
                  <div className="flex flex-wrap gap-1.5">
                  {currentStatus === 'completed' ? (
                    <>
                      <button
                        type="button"
                        disabled={savingStageId === row.stageRecord.id || !!nextStarted}
                        onClick={() => void saveStageInline(row, { status: 'pending' })}
                        className="rounded border border-ds-line/50 px-2 py-1 text-xs hover:bg-ds-card disabled:opacity-50"
                        title={nextStarted ? 'Next station already started' : 'Reopen this stage'}
                      >
                        Reopen
                      </button>
                      {nextKey ? (
                        <Link
                          href={`/production/stages/${nextKey}`}
                          className="rounded border border-ds-line/50 px-2 py-1 text-xs text-ds-ink hover:bg-ds-card"
                        >
                          View Next Stage
                        </Link>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={savingStageId === row.stageRecord.id}
                        onClick={() => void saveStageInline(row, { status: 'in_progress' })}
                        className="rounded border border-blue-600/40 px-2 py-1 text-xs text-blue-600 hover:bg-blue-500/10 disabled:opacity-50"
                      >
                        Start Production
                      </button>
                      <button
                        type="button"
                        disabled={savingStageId === row.stageRecord.id || !Number.isFinite(pushQty) || pushQty <= 0 || pushQty > availableToPush}
                        onClick={() => void pushToNext(row, pushQty, false)}
                        className="rounded border border-amber-600/40 px-2 py-1 text-xs text-ds-warning hover:bg-ds-warning/10 disabled:opacity-50"
                      >
                        Partial Push
                      </button>
                      {supervisorApprovalEnabled ? (
                        <>
                          <button
                            type="button"
                            disabled={savingStageId === row.stageRecord.id}
                            onClick={() => void setApproval(row, 'approved', null)}
                            className="rounded border border-violet-600/40 px-2 py-1 text-xs text-violet-600 hover:bg-violet-500/10 disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={savingStageId === row.stageRecord.id}
                            onClick={() => {
                              const remarks = prompt('Reject remarks', '')?.trim() ?? ''
                              void setApproval(row, 'rejected', remarks || null)
                            }}
                            className="rounded border border-violet-600/40 px-2 py-1 text-xs text-violet-600 hover:bg-violet-500/10 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        disabled={
                          savingStageId === row.stageRecord.id ||
                          availableToPush <= 0 ||
                          !stationChecklistKeys(stageKey).every(
                            (k) => checklistDrafts[row.stageRecord.id]?.[k] === true,
                          )
                        }
                        onClick={() => void completeAndPushNext(row)}
                        className="rounded border border-emerald-600/40 px-2 py-1 text-xs text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50"
                      >
                        Complete Push
                      </button>
                      <button
                        type="button"
                        disabled={savingStageId === row.stageRecord.id}
                        onClick={() => void bringBackFromNextStage(row)}
                        className="rounded border border-blue-600/40 px-2 py-1 text-xs text-blue-600 hover:bg-blue-500/10 disabled:opacity-50"
                      >
                        Undo Last Push
                      </button>
                      <button
                        type="button"
                        disabled={savingStageId === row.stageRecord.id}
                        onClick={() => {
                          setPushDrafts((prev) => ({ ...prev, [row.stageRecord.id]: '' }))
                          setWastageDrafts((prev) => ({ ...prev, [row.stageRecord.id]: '' }))
                        }}
                        className="rounded border border-ds-line/50 px-2 py-1 text-xs hover:bg-ds-card disabled:opacity-50"
                      >
                        Cancel Push
                      </button>
                      <button
                        type="button"
                        disabled={savingStageId === row.stageRecord.id}
                        onClick={() => void sendRework(row)}
                        className="rounded border border-rose-600/40 px-2 py-1 text-xs text-rose-600 hover:bg-rose-500/10 disabled:opacity-50"
                      >
                        Send Rework
                      </button>
                    </>
                  )}
                  </div>
                </div>
              </div>
            )
          })()}
          <div className="rounded-lg border border-ds-line/50 bg-ds-main px-3 py-3">
            <p className="text-xs uppercase tracking-wide text-ds-ink-faint mb-2">Quality checkpoint</p>
            {(() => {
              const keys = stationChecklistKeys(stageKey)
              const selected = keys.filter((k) => checklistDrafts[spotlight.stageRecord.id]?.[k] === true).length
              return (
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-ds-ink-faint">
                    Quality: <span className="text-ds-ink">{selected}/{keys.length}</span>
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded border border-ds-line/60 px-2 py-0.5 text-[11px] hover:bg-ds-card"
                      onClick={() =>
                        setChecklistDrafts((prev) => ({
                          ...prev,
                          [spotlight.stageRecord.id]: Object.fromEntries(keys.map((k) => [k, true])),
                        }))
                      }
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      className="rounded border border-ds-line/60 px-2 py-0.5 text-[11px] hover:bg-ds-card"
                      onClick={() =>
                        setChecklistDrafts((prev) => ({
                          ...prev,
                          [spotlight.stageRecord.id]: Object.fromEntries(keys.map((k) => [k, false])),
                        }))
                      }
                    >
                      Clear All
                    </button>
                  </div>
                </div>
              )
            })()}
            <div className="grid grid-cols-1 gap-1.5">
              {stationChecklistKeys(stageKey).map((item) => {
                const current = checklistDrafts[spotlight.stageRecord.id]?.[item] === true
                return (
                  <label key={item} className="inline-flex items-center gap-2 text-xs text-ds-ink">
                    <input
                      type="checkbox"
                      checked={current}
                      onChange={(e) =>
                        setChecklistDrafts((prev) => ({
                          ...prev,
                          [spotlight.stageRecord.id]: {
                            ...(prev[spotlight.stageRecord.id] ?? {}),
                            [item]: e.target.checked,
                          },
                        }))
                      }
                    />
                    <span>{item}</span>
                  </label>
                )
              })}
            </div>
            <p className="mt-2 text-[11px] text-ds-ink-faint">
              Complete Push requires all quality checks.
            </p>
          </div>
          <div className="rounded-lg border border-ds-line/50 bg-ds-main px-3 py-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-ds-ink-faint">Downtime logging</p>
              <button
                type="button"
                onClick={() => setShowDowntime((v) => !v)}
                className="rounded border border-ds-line/60 px-2 py-0.5 text-[11px] hover:bg-ds-card"
              >
                {showDowntime ? 'Hide' : 'Show'}
              </button>
            </div>
            {showDowntime ? (
              <>
            <button
              type="button"
              className="rounded border border-ds-line/60 px-2 py-1 text-xs hover:bg-ds-card"
              onClick={async () => {
                const machine = prompt('Machine', spotlight.jobCard.machine?.machineCode ?? '')?.trim() ?? ''
                const reason = prompt('Downtime reason (breakdown/plate/die/material/operator/power/quality/other)', '')?.trim() ?? ''
                const start = prompt('Start time (ISO/local text)', '')?.trim() ?? ''
                const end = prompt('End time (ISO/local text)', '')?.trim() ?? ''
                const remarks = prompt('Remarks', '')?.trim() ?? ''
                if (!reason) {
                  toast.error('Downtime reason is required')
                  return
                }
                const ex = getExecutionState(spotlight)
                const logs = Array.isArray(ex.downtimeLogs) ? ex.downtimeLogs : []
                const res = await fetch(`/api/job-cards/${spotlight.jobCard.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    postPressRouting: {
                      ...(spotlight.jobCard.postPressRouting && typeof spotlight.jobCard.postPressRouting === 'object'
                        ? spotlight.jobCard.postPressRouting
                        : {}),
                      executionOrchestration: {
                        ...ex,
                        downtimeLogs: [
                          ...logs,
                          {
                            stage: stageKey,
                            machine,
                            reason,
                            start,
                            end,
                            remarks,
                            at: new Date().toISOString(),
                            operator: spotlight.stageRecord.operator ?? null,
                          },
                        ],
                      },
                    },
                  }),
                })
                const json = await res.json().catch(() => ({}))
                if (!res.ok) {
                  toast.error(typeof json?.error === 'string' ? json.error : 'Failed to log downtime')
                  return
                }
                toast.success('Downtime logged')
                await load()
              }}
            >
              Log downtime
            </button>
            <div className="mt-2 space-y-1 text-xs">
              {(Array.isArray(getExecutionState(spotlight).downtimeLogs)
                ? getExecutionState(spotlight).downtimeLogs
                : []
              )
                .filter((x) => (x as Record<string, unknown>).stage === stageKey)
                .slice(-3)
                .map((x, i) => {
                  const r = x as Record<string, unknown>
                  return (
                    <div key={`${i}-${String(r.at ?? '')}`} className="text-ds-ink-faint">
                      {String(r.reason ?? '—')} · {String(r.start ?? '-')} → {String(r.end ?? '-')}
                    </div>
                  )
                })}
            </div>
              </>
            ) : null}
          </div>
          <div className="rounded-lg border border-ds-line/50 bg-ds-main px-3 py-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-ds-ink-faint">Production timeline</p>
              <button
                type="button"
                onClick={() => setShowTimeline((v) => !v)}
                className="rounded border border-ds-line/60 px-2 py-0.5 text-[11px] hover:bg-ds-card"
              >
                {showTimeline ? 'Hide' : 'Show'}
              </button>
            </div>
            {showTimeline ? (
            <div className="space-y-1 text-xs text-ds-ink-faint">
              {(Array.isArray(getExecutionState(spotlight).stagePushTrail)
                ? getExecutionState(spotlight).stagePushTrail
                : []
              )
                .slice(-8)
                .reverse()
                .map((ev, i) => {
                  const r = ev as Record<string, unknown>
                  return (
                    <div key={`${i}-${String(r.at ?? '')}`}>
                      {String(r.at ?? '-')} · {String(r.fromStage ?? '-')} → {String(r.toStage ?? '-')} · qty {String(r.qtyTransferred ?? 0)}
                    </div>
                  )
                })}
            </div>
            ) : null}
          </div>
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
