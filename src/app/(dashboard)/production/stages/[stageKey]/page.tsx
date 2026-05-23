'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from '@/store/toastStore'
import { PRODUCTION_STAGES } from '@/lib/constants'
import { ChevronDown, ChevronUp, CircleDollarSign, FileText, PanelRightOpen, RotateCcw, Star, Trash2 } from 'lucide-react'
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
import { StatusBadge, Button as DsButton } from '@/components/design-system'
import { ICON_BUTTON_BASE } from '@/components/design-system/tokens'
import { PackingConfigEditor } from '@/components/industrial/PackingConfigEditor'
import { normalizePackingConfig, packingTotal, type PackingConfig } from '@/lib/dispatch-packing'
import { Package } from 'lucide-react'
import { getTerminalRule, resolvePrintingMachine } from '@/lib/production-terminal-rules'

const mono = 'font-designing-queue tabular-nums tracking-tight'
const stageCellPad = 'px-1.5 py-1 align-middle'
const stageHeadCell = 'px-1.5 py-1 font-semibold'

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
  machineCode?: string | null
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
    ups?: number | null
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
  if (oee >= 85) return 'text-[var(--success)]'
  if (oee >= 60) return 'text-ds-warning'
  return 'text-[var(--error)]'
}

export default function ProductionStagePage() {
  const params = useParams()
  const stageKey = params.stageKey as string
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
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
  const checklistInitedRef = useRef<Set<string>>(new Set())
  const [tab, setTab] = useState<'pending' | 'make_ready' | 'running' | 'hold' | 'completed'>('pending')
  const [savingStageId, setSavingStageId] = useState<string | null>(null)
  const [selectedStageRecordIds, setSelectedStageRecordIds] = useState<Set<string>>(new Set())
  const [localSearch, setLocalSearch] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [showDowntime, setShowDowntime] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  // Pasting completion captures a structured packing manifest (boxes × qty/box)
  // before pushing to Dispatch. Drawer state lives here; null = closed.
  const [pastingPackDraft, setPastingPackDraft] = useState<{
    row: Payload['jobCards'][number]
    packing: PackingConfig
  } | null>(null)
  const [pastingPackSaving, setPastingPackSaving] = useState(false)

  const stageMeta = PRODUCTION_STAGES.find((s) => s.key === stageKey)
  const terminalRule = getTerminalRule(stageKey)
  const [stationOperators, setStationOperators] = useState<{ id: string; name: string }[]>([])
  const [machineDrafts, setMachineDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!stageKey) return
    fetch(`/api/operator-master?activeOnly=1&stageKey=${stageKey}`)
      .then((r) => r.json())
      .then((data: { operators?: { id: string; name: string }[] }) => {
        setStationOperators((data.operators ?? []).map((o) => ({ id: o.id, name: o.name })))
      })
      .catch(() => setStationOperators([]))
  }, [stageKey])

  function getRowMachine(row: Payload['jobCards'][number]): string {
    return machineDrafts[row.stageRecord.id] ?? row.stageRecord.machineCode ?? (terminalRule.fixedMachineCode ?? '')
  }

  function effMachineForRow(row: Payload['jobCards'][number]): string | null {
    const op = getRowOperator(row).trim()
    if (terminalRule.machineAutoFromOperator) return resolvePrintingMachine(op)
    if (terminalRule.fixedMachineCode) return terminalRule.fixedMachineCode
    return machineDrafts[row.stageRecord.id] ?? row.stageRecord.machineCode ?? null
  }

  // Tracks whether the first load has landed — used to choose between full
  // loading gate and background refresh without putting `data` in `load`'s deps
  // (which would create an infinite fetch loop).
  const hasLoadedRef = useRef(false)

  const load = useCallback(async () => {
    if (!stageKey) return
    // First load: full loading gate. Subsequent reloads: background refresh only.
    if (!hasLoadedRef.current) {
      setLoading(true)
    } else {
      setRefreshing(true)
    }
    try {
      const r = await fetch(`/api/production/stages/${stageKey}`)
      const json = (await r.json()) as Payload & { error?: string }
      if ((json as { error?: string }).error) throw new Error((json as { error: string }).error)
      setData(json)
      hasLoadedRef.current = true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
      setRefreshing(false)
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

  // Keep the open drawer (spotlight) bound to the freshest row data after any reload.
  // Without this, status badges and action buttons inside the drawer show stale values
  // until the user closes and re-opens it.
  useEffect(() => {
    setSpotlight((prev) => {
      if (!prev) return prev
      const fresh = data?.jobCards?.find((j) => j.stageRecord.id === prev.stageRecord.id)
      return fresh ?? prev
    })
  }, [data])

  // Restore saved quality checklist from server when a drawer row is first opened.
  useEffect(() => {
    if (!spotlight) return
    const id = spotlight.stageRecord.id
    if (checklistInitedRef.current.has(id)) return
    checklistInitedRef.current.add(id)
    const ppr = spotlight.jobCard.postPressRouting
    const ex = ppr && typeof ppr === 'object' ? (ppr as Record<string, unknown>).executionOrchestration : null
    const byStage = ex && typeof ex === 'object' ? (ex as Record<string, unknown>).checklistByStage : null
    const saved = byStage && typeof byStage === 'object'
      ? (byStage as Record<string, Record<string, boolean>>)[stageKey]
      : null
    if (saved && typeof saved === 'object') {
      setChecklistDrafts((prev) => ({ ...prev, [id]: { ...saved } }))
    }
  }, [spotlight?.stageRecord.id, stageKey])

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
    const statusRank = (s: string): number => {
      // pending/ready first (0), in-progress mid (1), completed last (2). Everything else sits
      // with pending so it doesn't unexpectedly sink to the bottom.
      if (s === 'completed') return 2
      if (s === 'in_progress' || s === 'partial_running') return 1
      return 0
    }
    arr.sort((a, b) => {
      const sa = String(getStageProgress(a).status ?? a.stageRecord.status ?? 'pending').toLowerCase()
      const sb = String(getStageProgress(b).status ?? b.stageRecord.status ?? 'pending').toLowerCase()
      const ra = statusRank(sa)
      const rb = statusRank(sb)
      if (ra !== rb) return ra - rb
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
    const search = localSearch.trim().toLowerCase()
    return list.filter((row) => {
      const p = getStageProgress(row)
      const status = String(p.status ?? row.stageRecord.status ?? 'pending').toLowerCase()
      const pushedQty = Number(p.pushedQty || 0)
      const product = String(row.jobCard.productName ?? row.jobCard.poMeta?.cartonName ?? '').toLowerCase()
      const client = String(row.jobCard.customer?.name ?? '').toLowerCase()
      const job = String(row.jobCard.jobCardNumber ?? '').toLowerCase()
      if (search && !product.includes(search) && !client.includes(search) && !job.includes(search)) return false
      if (tab === 'pending') {
        // Sticky working list: once an operator touches a row (Start Production → Push →
        // Complete), it stays anchored in their working list with a colour cue, instead of
        // jumping to a different tab. Hold/blocked still move to the Hold tab.
        if (stickyPushTrackingEnabled) {
          if (pushedQty > 0) return true
          if (
            status === 'pending' ||
            status === 'ready' ||
            status === 'ready_to_receive' ||
            status === 'in_progress' ||
            status === 'partial_running' ||
            status === 'completed'
          ) {
            return true
          }
          return false
        }
        return status === 'pending' || status === 'ready' || status === 'ready_to_receive'
      }
      if (tab === 'make_ready') return status === 'make_ready_alert' || status === 'make_ready_started' || status === 'ready_to_receive'
      if (tab === 'running') return status === 'in_progress' || status === 'partial_running' || status === 'rework'
      if (tab === 'hold') return status === 'hold' || status === 'blocked'
      return status === 'completed'
    })
  }, [list, tab, stickyPushTrackingEnabled, localSearch])

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
    className = '',
  }: {
    columnKey: SortKey
    children: React.ReactNode
    className?: string
  }) {
    const active = sortBy === columnKey
    return (
      <th
        className={`${stageHeadCell} cursor-pointer select-none text-left hover:bg-ds-elevated/50 ${className}`}
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
      return outputs.dyeCutting || fallback
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
    if (s === 'make_ready_alert') return 'bg-[var(--warning-bg)] text-[var(--warning)]'
    if (s === 'make_ready_started') return 'bg-[var(--info-bg)] text-[var(--info)]'
    if (s === 'ready_to_receive') return 'bg-cyan-500/12 text-cyan-700'
    if (s === 'partial_running') return 'bg-orange-500/12 text-orange-700'
    if (s === 'in_progress') return 'bg-[var(--info-bg)] text-[var(--info)]'
    if (s === 'completed') return 'bg-[var(--success-bg)] text-[var(--success)]'
    if (s === 'hold' || s === 'blocked') return 'bg-slate-500/12 text-slate-700'
    if (s === 'rework') return 'bg-[var(--error-bg)] text-[var(--error)]'
    return 'bg-ds-elevated text-ds-ink-muted'
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
    // Pasting may receive 0 from upstream if handoff hasn't happened yet in executionOrchestration;
    // allow save as long as the previous stage exists in stageMap or has pushed something.
    if (stageKey !== 'cutting' && stageKey !== 'pasting' && counter != null && counter > 0 && (!Number.isFinite(received) || received <= 0)) {
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
            machineCode: effMachineForRow(row),
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

  // Returns the physical sheet count flowing into pasting from die cutting.
  // Uses dye_cutting.pushedQty (actual handoff) → legacy stageOutputs → planned sheets.
  function pastingInboundSheets(row: Payload['jobCards'][number]): number {
    const ex = getExecutionState(row)
    const dyePushed = Number(ex.stageProgress?.['dye_cutting']?.pushedQty ?? 0)
    if (dyePushed > 0) return dyePushed
    const outputs = (row.jobCard.stageOutputs as Record<string, number> | null) ?? {}
    const fromOutputs = Number(outputs['dyeCutting'] || 0)
    if (fromOutputs > 0) return fromOutputs
    return row.jobCard.requiredSheets || row.jobCard.totalSheets || 0
  }

  function pastingExpectedCartons(row: Payload['jobCards'][number]): number {
    const sheetsIn = pastingInboundSheets(row)
    const ups = pastingUps(row)
    return ups > 0 ? Math.round(sheetsIn * ups) : sheetsIn
  }

  function pastingUps(row: Payload['jobCards'][number]): number {
    const spec = row.jobCard.poMeta?.specOverrides ?? {}
    const planningCore =
      spec.planningCore && typeof spec.planningCore === 'object'
        ? (spec.planningCore as Record<string, unknown>)
        : {}
    const planningUps = Number(
      (planningCore.ups as number | undefined) ??
      ((spec as Record<string, unknown>).ups as number | undefined) ??
      0,
    )
    if (Number.isFinite(planningUps) && planningUps >= 1) return Math.floor(planningUps)
    const metaUps = Number(row.jobCard.poMeta?.ups ?? 0)
    if (Number.isFinite(metaUps) && metaUps >= 1) return Math.floor(metaUps)
    return 0
  }

  function requiredStageKeysForRow(row: Payload['jobCards'][number]): string[] {
    const pp = row.jobCard.postPressRouting && typeof row.jobCard.postPressRouting === 'object'
      ? (row.jobCard.postPressRouting as Record<string, unknown>)
      : {}
    const out: string[] = ['cutting', 'printing']
    // Spot UV runs within coating, not as a standalone stage.
    if (pp.chemicalCoating === true || pp.spotUv === true) out.push('chemical_coating')
    if (pp.lamination === true) out.push('lamination')
    // Leafing/Embossing execute within Die Cutting. Pasting is terminal → Dispatch → Billing.
    out.push('dye_cutting', 'pasting')
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

  async function completePastingTerminal(
    row: Payload['jobCards'][number],
    packing?: PackingConfig,
  ) {
    const counter = Number(getRowCounter(row) || 0)
    if (counter <= 0) {
      toast.error('Enter actual counter before completing pasting')
      return
    }
    const checklist = checklistDrafts[row.stageRecord.id] ?? {}
    const requiredChecklist = stationChecklistKeys(stageKey)
    if (requiredChecklist.length > 0 && !requiredChecklist.every((k) => checklist[k] === true)) {
      toast.error('Complete required quality checklist before completing')
      return
    }
    const auto = computeAutoFromCounter(row, getRowCounter(row))
    const wastageQty = auto.wastage
    const progress = getStageProgress(row)
    const plannedQty = progress.plannedQty || pastingExpectedCartons(row)
    const postPress = row.jobCard.postPressRouting && typeof row.jobCard.postPressRouting === 'object'
      ? (row.jobCard.postPressRouting as Record<string, unknown>)
      : {}
    const ex = getExecutionState(row)
    const stageProgress = (ex.stageProgress && typeof ex.stageProgress === 'object')
      ? (ex.stageProgress as Record<string, StageProgress>)
      : {}
    const nowIso = new Date().toISOString()
    // Packing manifest captured before completion — drives the Dispatch row.
    const packingRows = normalizePackingConfig(packing ?? [])
    const totalPackedQty = packingRows.length ? packingTotal(packingRows) : null
    const updatedProgress = {
      ...stageProgress,
      [stageKey]: {
        ...(stageProgress[stageKey] ?? {}),
        plannedQty,
        completedQty: counter,
        pushedQty: counter,
        wastageQty,
        status: 'completed',
        completedBy: getRowOperator(row).trim() || null,
        completedAt: nowIso,
        ...(packingRows.length
          ? { packingConfig: packingRows, totalPackedQty }
          : {}),
      },
    }
    setSavingStageId(row.stageRecord.id)
    try {
      // Save via job-card PUT — same path as pushToNext; the stages API has no POST handler.
      const res = await fetch(`/api/job-cards/${row.jobCard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stages: [{ id: row.stageRecord.id, operator: getRowOperator(row).trim() || null, counter, status: 'completed' }],
          postPressRouting: {
            ...postPress,
            executionOrchestration: {
              ...(ex as Record<string, unknown>),
              stageProgress: updatedProgress,
              checklistByStage: {
                ...((ex as Record<string, unknown>).checklistByStage && typeof (ex as Record<string, unknown>).checklistByStage === 'object'
                  ? (ex as Record<string, unknown>).checklistByStage as Record<string, unknown>
                  : {}),
                [stageKey]: checklist,
              },
            },
          },
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error((j as { error?: string }).error || 'Save failed')
      }
      toast.success(`Pasting complete — ${counter.toLocaleString('en-IN')} cartons ready for Dispatch`)
      await load()
      setSpotlight(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingStageId(null)
    }
  }

  async function pushToNext(
    row: Payload['jobCards'][number],
    requestedPushQty: number,
    markCompleted: boolean,
    skipReload = false,
  ) {
    const nextKey = nextRequiredStageKey(row)
    if (!nextKey) {
      if (stageKey === 'pasting') {
        await completePastingTerminal(row)
      } else {
        toast.error('No next station configured')
      }
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
    if (stageKey === 'pasting') {
      const ups = pastingUps(row)
      if (ups <= 0) {
        toast.error('UPS missing for this job. Set UPS in planning before pasting push.')
        return
      }
      if (pushQty % ups !== 0) {
        toast.error(`Pasting push qty must be a multiple of UPS (${ups})`)
        return
      }
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
      const nextStagePlannedIncrement =
        nextKey === 'pasting'
          ? pushQty * Math.max(1, pastingUps(row))
          : pushQty
      const stationFinished = markCompleted && updatedPushed >= plannedQty

      const token = nextKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      const queuedField = `${token}QueuedAt`
      const bundleNo = `BND-${row.jobCard.jobCardNumber}-${stageKey}-${Date.now().toString().slice(-6)}`
      const stagePayload = [
        {
          id: row.stageRecord.id,
          operator: getRowOperator(row).trim() || null,
          counter: updatedCompleted,
          machineCode: effMachineForRow(row),
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
                  // Always land in pending after handoff; operator must press Start Production.
                  status: 'pending',
                  plannedQty: Number(nextStageProgress.plannedQty || 0) + nextStagePlannedIncrement,
                },
              },
              triageByStage: {
                ...triageByStage,
                [nextKey]: {
                  ...nextStageTriage,
                  [nextTriageKey]: {
                    ...existingNextTriageCard,
                    status: 'pending',
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
          : '') +
        (refreshing ? ' · syncing…' : '')
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Link
            href="/production/stages"
            className="inline-flex items-center gap-1 rounded-ds-sm px-2.5 py-1.5 text-xs text-ds-ink-faint hover:bg-ds-elevated hover:text-ds-ink transition-colors"
          >
            <span aria-hidden>←</span> All stages
          </Link>
          <span className="text-ds-line/60 text-xs select-none">·</span>
          <Link
            href={`/production/stages/${stageKey}/triage`}
            className="inline-flex items-center gap-1.5 rounded-ds-sm bg-ds-warning/8 px-3 py-1.5 text-xs font-medium text-ds-warning hover:bg-ds-warning/15 transition-colors"
          >
            Open Triage
          </Link>
        </div>
        <Link
          href="/production/job-cards"
          className="inline-flex items-center gap-1.5 rounded-ds-sm bg-ds-elevated/60 px-3 py-1.5 text-xs text-ds-ink-muted hover:text-ds-warning transition-colors"
        >
          Job Cards
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={localSearch}
          onChange={(e) => setLocalSearch(e.target.value)}
          className="ds-toolbar-search"
          placeholder="Search by job card, product, client…"
          aria-label="Search stage queue"
        />
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
              className={`rounded-full px-3 py-1 text-xs ${tab === t ? 'text-ds-warning bg-ds-warning/10' : 'text-ds-ink-muted hover:bg-ds-card'}`}
            >
              {t.replace('_', ' ')}: {count}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-ds-ink-faint tabular-nums">{selectedCount > 0 ? `${selectedCount} selected` : 'Select rows'}</span>
        <button
          type="button"
          disabled={bulkBusy || visibleList.length === 0}
          onClick={() => selectAllInCurrentTab()}
          className="rounded-ds-sm bg-ds-elevated px-2.5 py-1 text-xs text-ds-ink-muted hover:bg-ds-elevated/80 disabled:opacity-40"
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
          className="rounded-ds-sm bg-ds-warning/10 px-2.5 py-1 text-xs text-ds-warning hover:bg-ds-warning/15 disabled:opacity-40"
        >
          Bulk Start
        </button>
        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0}
          onClick={() =>
            void runBulkAction('Bulk Complete Push', async (row) => {
              await completeAndPushNext(row, true)
            })
          }
          className="rounded-ds-sm bg-[var(--success-bg)] px-2.5 py-1 text-xs text-[var(--success)] hover:bg-[var(--success-bg)]/80 disabled:opacity-40"
        >
          Bulk Complete
        </button>
        <details className="relative">
          <summary className="list-none cursor-pointer rounded-ds-sm bg-ds-elevated px-2.5 py-1 text-xs text-ds-ink-muted hover:bg-ds-elevated/80">
            More
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-56 rounded-ds-sm bg-white p-1 shadow-lg">
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
              className="block w-full rounded px-2 py-1.5 text-left text-xs text-ds-warning hover:bg-amber-50 disabled:opacity-50"
            >
              Bulk Partial Push
            </button>
            <button
              type="button"
              disabled={bulkBusy || selectedCount === 0}
              onClick={() => void runBulkAction('Bulk Undo Push', async (row) => { await bringBackFromNextStage(row, true) })}
              className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--info)] hover:bg-sky-50 disabled:opacity-50"
            >
              Bulk Undo
            </button>
            <button
              type="button"
              disabled={bulkBusy || selectedCount === 0}
              onClick={() => void runBulkAction('Bulk Rework Mark', async (row) => { await saveStageInline(row, { status: 'rework', skipReload: true }) })}
              className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--error)] hover:bg-rose-50 disabled:opacity-50"
            >
              Bulk Rework
            </button>
            <button
              type="button"
              disabled={bulkBusy || selectedCount === 0}
              onClick={() => void bulkDeleteFromStage()}
              className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--error)] hover:bg-rose-50 disabled:opacity-50"
            >
              {bulkBusy ? 'Working…' : 'Bulk Delete'}
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void clearFromCurrentStageOnward()}
              className="block w-full rounded px-2 py-1.5 text-left text-xs text-ds-warning hover:bg-amber-50 disabled:opacity-50"
            >
              Clear from {label} onward
            </button>
          </div>
        </details>
        <button
          type="button"
          disabled={bulkBusy || selectedCount === 0}
          onClick={() => setSelectedStageRecordIds(new Set())}
          className="rounded-ds-sm bg-ds-elevated px-2.5 py-1 text-xs text-ds-ink-faint hover:bg-ds-elevated/80 disabled:opacity-40"
        >
          Clear Selection
        </button>
      </div>

      <div className={industrialTableClassName()}>
        <table className="w-full min-w-full table-fixed border-collapse text-left text-sm leading-tight md:min-w-[1180px]">
          <thead className="sticky top-0 z-[30] bg-ds-main/95 text-ds-ink-muted backdrop-blur">
            <tr>
              <th className={`${stageHeadCell} w-8 text-center`}>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={(e) => toggleVisibleSelection(e.target.checked)}
                  aria-label="Select visible rows"
                  className="h-3.5 w-3.5 accent-ds-brand"
                />
              </th>
              <th className={`${stageHeadCell} hidden w-[7rem] lg:table-cell`}>Operator</th>
              <th className={`${stageHeadCell} hidden w-[5.75rem] lg:table-cell`}>Machine</th>
              <SortHeader columnKey="jobCardNumber" className="hidden w-[6.5rem] md:table-cell">Job Card</SortHeader>
              <SortHeader columnKey="productName" className="w-auto md:w-[15rem]">Product / Carton</SortHeader>
              <th className={`${stageHeadCell} hidden w-[5rem] xl:table-cell`}>Set</th>
              <th className={`${stageHeadCell} hidden w-[10rem] lg:table-cell`}>Client</th>
              <th className={`${stageHeadCell} hidden w-[6.75rem] xl:table-cell`}>Input</th>
              <th className={`${stageHeadCell} hidden w-[8rem] lg:table-cell`}>Sheet / Cut</th>
              <th className={`${stageHeadCell} hidden w-[7rem] text-right sm:table-cell`}>{stageKey === 'pasting' ? 'Expected' : 'Required'}</th>
              <th className={`${stageHeadCell} hidden w-[10rem] md:table-cell`}>{stageKey === 'pasting' ? 'Actual / Wastage' : 'Actual Counter'}</th>
              <th className={`${stageHeadCell} hidden w-[7.25rem] sm:table-cell md:w-[12rem]`}>Status</th>
              <SortHeader columnKey="completedAt" className="hidden w-[8rem] xl:table-cell">Completed</SortHeader>
              <th className={`${stageHeadCell} sticky right-0 z-[31] w-[5.5rem] bg-ds-main/95 text-right sm:w-[7.5rem]`}>Actions</th>
            </tr>
          </thead>
          <tbody>
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
              const ups = pastingUps(row)
              const expectedCartons = stageKey === 'pasting' ? pastingExpectedCartons(row) : null
              const actualCartons = stageKey === 'pasting' ? actual : null
              const wastageCartons = stageKey === 'pasting' ? Math.max(0, Number(expectedCartons ?? 0) - Number(actualCartons ?? 0)) : null
              const wastageSheets = stageKey === 'pasting' && ups > 0 && wastageCartons != null
                ? Math.round(wastageCartons / ups)
                : null
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
                  className={`hover:bg-ds-card/50 cursor-pointer ${(() => {
                    const rs = String(progress.status ?? stageRecord.status ?? '').toLowerCase()
                    if (rs === 'completed' || pushedForTracking) return 'bg-[var(--success-bg)]'
                    if (rs === 'in_progress' || rs === 'partial_running') return 'bg-[var(--warning-bg)]'
                    return ''
                  })()}`}
                  onClick={() => setSpotlight(row)}
                >
                  <td className={`${stageCellPad} text-center`} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedStageRecordIds.has(stageRecord.id)}
                      onChange={(e) => toggleRowSelection(stageRecord.id, e.target.checked)}
                      aria-label={`Select row ${stageRecord.id}`}
                      className="h-3.5 w-3.5 accent-ds-brand"
                    />
                  </td>
                  <td className={`${stageCellPad} hidden truncate text-xs text-ds-ink lg:table-cell`} title={getRowOperator(row) || undefined}>{getRowOperator(row) || '—'}</td>
                  <td className={`${stageCellPad} hidden truncate text-xs text-ds-ink-muted lg:table-cell`}>{jobCard.machine?.machineCode ?? '—'}</td>
                  <td className={`${stageCellPad} hidden font-mono text-xs font-semibold text-[var(--brand-primary)] md:table-cell`}>{jobCard.jobCardNumber}</td>
                  <td className={stageCellPad}>
                    <div className="mb-0.5 flex min-w-0 items-center gap-1 md:hidden">
                      <span className={`${mono} shrink-0 text-xs font-semibold text-[var(--brand-primary)]`}>JC-{jobCard.jobCardNumber}</span>
                      <span className="truncate text-[11px] text-ds-ink-faint">{jobCard.machine?.machineCode ?? 'No machine'}</span>
                    </div>
                    <div className="line-clamp-2 break-words text-xs font-medium text-ds-ink" title={jobCard.productName ?? poMeta?.cartonName ?? undefined}>{jobCard.productName ?? poMeta?.cartonName ?? '—'}</div>
                    <div className="line-clamp-2 text-[11px] leading-snug text-ds-ink-faint">
                      PO {poMeta?.poNumber ?? '—'} · Qty {Number(poMeta?.quantity ?? 0).toLocaleString('en-IN')}
                      <span className="lg:hidden"> · {jobCard.customer.name}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1 sm:hidden">
                      <StatusBadge
                        status={
                          supervisorApprovalEnabled && progress.approvalStatus === 'pending'
                            ? 'pending_approval'
                            : String(progress.status ?? stageRecord.status ?? 'pending')
                        }
                        className={statusClass(String(progress.status ?? stageRecord.status ?? 'pending'))}
                      />
                      {pushSummary ? (
                        <span className="line-clamp-1 text-[10px] leading-none text-[var(--success)]">
                          {pushSummary.qty.toLocaleString('en-IN')} pushed
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className={`${stageCellPad} hidden truncate text-xs xl:table-cell`}>{jobCard.setNumber ?? '—'}</td>
                  <td className={`${stageCellPad} hidden truncate text-xs lg:table-cell`} title={jobCard.customer.name}>{jobCard.customer.name}</td>
                  <td className={`${stageCellPad} hidden text-xs xl:table-cell`}>
                    {stageKey === 'cutting' ? (
                      <span className="line-clamp-2 break-words">{poMeta?.paperType ?? '—'}</span>
                    ) : (
                      <span className={mono}>{Number(received).toLocaleString('en-IN')}</span>
                    )}
                  </td>
                  <td className={`${stageCellPad} hidden text-xs lg:table-cell`}>
                    <div className="truncate" title={cutSize}>{cutSize}</div>
                    <div className="truncate text-[11px] text-ds-ink-faint">
                      {stageKey === 'cutting' || stageKey === 'pasting'
                        ? `UPS ${ups || '—'}`
                        : `GSM ${poMeta?.gsm ?? '—'}`}
                    </div>
                  </td>
                  <td className={`${stageCellPad} hidden text-right text-xs sm:table-cell ${mono}`}>
                    {Number(defaultRequired).toLocaleString('en-IN')}
                    {stageKey === 'pasting' ? (
                      <span className="ml-1 text-[11px] text-ds-ink-faint">cartons</span>
                    ) : (
                      <span className="ml-1 text-[11px] text-ds-ink-faint">sheets</span>
                    )}
                  </td>
                  <td className={`${stageCellPad} hidden md:table-cell`}>
                    <span className={`${mono}`}>{Number(getRowCounter(row) || 0).toLocaleString('en-IN')}</span>
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ds-ink-faint">
                      {stageKey === 'pasting'
                        ? `Wastage: ${(wastageCartons ?? 0).toLocaleString('en-IN')} cartons${wastageSheets != null ? ` · ${wastageSheets.toLocaleString('en-IN')} sheets` : ''}`
                        : `Pushed: ${alreadyPushedQty.toLocaleString('en-IN')} · Balance: ${Number(balance).toLocaleString('en-IN')}`}
                    </div>
                  </td>
                  <td className={`${stageCellPad} hidden sm:table-cell`}>
                    <StatusBadge
                      status={
                        supervisorApprovalEnabled && progress.approvalStatus === 'pending'
                          ? 'pending_approval'
                          : String(progress.status ?? stageRecord.status ?? 'pending')
                      }
                      className={statusClass(String(progress.status ?? stageRecord.status ?? 'pending'))}
                    />
                    {alreadyPushedQty > 0 && alreadyPushedQty < completedQty ? (
                      <span className="ml-1 rounded-full bg-[var(--warning-bg)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--warning)]">
                        partially_pushed
                      </span>
                    ) : null}
                    {pushSummary ? (
                      <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--success)]">
                        {pushSummary.partial ? 'Partially pushed' : 'Pushed'} to next stage ({pushSummary.label}):{' '}
                        {pushSummary.qty.toLocaleString('en-IN')}
                      </div>
                    ) : null}
                    <div className="mt-1 hidden items-center gap-1 md:flex">
                      <span className="text-[10px] text-ds-ink-faint">Q#{triage.sequenceNo}</span>
                      {triage.plannedStartTs !== Number.MAX_SAFE_INTEGER ? (
                        <span className="text-[10px] text-ds-ink-faint">· {new Date(triage.plannedStartTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className={`${stageCellPad} hidden text-xs text-ds-ink-muted xl:table-cell`}>
                    {stageRecord.completedAt ? new Date(stageRecord.completedAt).toLocaleString() : '—'}
                  </td>
                  <td className={`${stageCellPad} sticky right-0 z-10 bg-inherit text-right`} onClick={(e) => e.stopPropagation()}>
                    <div className="grid grid-cols-2 place-items-end gap-1 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
                      <button
                        type="button"
                        title="Open decisions drawer"
                        aria-label="Open decisions drawer"
                        onClick={() => setSpotlight(row)}
                        className="inline-flex items-center justify-center rounded-ds-sm bg-ds-warning/10 p-1 text-ds-warning hover:bg-ds-warning/15 disabled:opacity-50"
                      >
                        <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>
                      <Link
                        href={`/production/job-cards/${jobCard.id}`}
                        title="Open job card"
                        aria-label={`Open job card ${jobCard.jobCardNumber}`}
                        className={`${ICON_BUTTON_BASE} bg-ds-card/40 text-ds-ink-muted hover:bg-ds-warning/8 hover:text-ds-warning`}
                      >
                        <FileText className="h-3.5 w-3.5" strokeWidth={2} />
                      </Link>
                      <button
                        type="button"
                        title="Reverse stage"
                        aria-label="Reverse stage"
                        disabled={bulkBusy}
                        onClick={() => void reverseRowStage(row)}
                        className={`${ICON_BUTTON_BASE} text-[var(--info)] hover:bg-[var(--info-bg)] disabled:opacity-50`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        title="Delete from stage"
                        aria-label="Delete from stage"
                        disabled={bulkBusy}
                        onClick={() => void deleteRowFromStage(row)}
                        className={`${ICON_BUTTON_BASE} text-[var(--error)] hover:bg-[var(--error-bg)] disabled:opacity-50`}
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
      {stageKey === 'dye_cutting' && list.some((x) => x.stageRecord.status === 'completed') ? (
        <div className="rounded-ds-lg bg-ds-warning/10 p-4">
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
        <div className="rounded-ds-lg bg-ds-warning/10 p-4">
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
        <div className="space-y-3 text-sm text-ds-ink-muted">
          {/* OEE card */}
          <div className="rounded-ds-lg bg-ds-elevated/30 px-4 py-3.5 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--brand-primary)]">Live OEE</p>
            {spotlight.jobCard.oee ? (
              <>
                <p className={`${mono} text-2xl font-bold ${oeeBandClass(spotlight.jobCard.oee.oee)}`}>
                  OEE {spotlight.jobCard.oee.oee}%
                </p>
                <div className={`grid grid-cols-3 gap-2 text-xs ${mono}`}>
                  <div className="rounded-ds-md bg-ds-card/60 px-2 py-1.5 text-center">
                    <div className="text-ds-ink-faint text-[10px] mb-0.5">Availability</div>
                    <div className="text-ds-ink font-semibold">{spotlight.jobCard.oee.availability}%</div>
                  </div>
                  <div className="rounded-ds-md bg-ds-card/60 px-2 py-1.5 text-center">
                    <div className="text-ds-ink-faint text-[10px] mb-0.5">Performance</div>
                    <div className="text-ds-ink font-semibold">{spotlight.jobCard.oee.performance}%</div>
                  </div>
                  <div className="rounded-ds-md bg-ds-card/60 px-2 py-1.5 text-center">
                    <div className="text-ds-ink-faint text-[10px] mb-0.5">Quality</div>
                    <div className="text-ds-ink font-semibold">{spotlight.jobCard.oee.quality}%</div>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-ds-ink-faint mb-1.5">
                    Live speedometer (sheets/h)
                  </p>
                  <div className="h-2 w-full rounded-full bg-ds-card overflow-hidden">
                    <div
                      className="h-full bg-ds-warning transition-all duration-500"
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
                  <p className={`mt-1.5 ${mono} text-xs text-ds-ink`}>
                    {spotlight.jobCard.oee.currentSpeedPph} / {Math.round(spotlight.jobCard.oee.ratedSpeedPph)} sh/h
                    <span className="text-ds-ink-faint ml-1.5">limit</span>
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
                  <p className="text-[var(--error)] text-xs font-medium">Downtime lock — log reason on shopfloor terminal.</p>
                ) : null}
              </>
            ) : (
              <p className="text-ds-ink-faint text-xs">No live OEE for this row — start stage to see metrics.</p>
            )}
          </div>
          {spotlight.jobCard.incentiveLedger?.incentiveEligible ? (
            <div className="rounded-ds-lg bg-[var(--success-bg)] px-4 py-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--success)] mb-2.5">Incentive Earned</p>
              <div className="flex items-start gap-3">
                <CircleDollarSign className="h-6 w-6 text-[var(--success)] shrink-0 mt-0.5" strokeWidth={1.75} />
                <div className="space-y-1.5">
                  <p className={`text-xs text-ds-ink-muted ${mono}`}>
                    Ledger yield {spotlight.jobCard.incentiveLedger.yieldPercent ?? '—'}% · OEE{' '}
                    {spotlight.jobCard.incentiveLedger.oeePct}%
                  </p>
                  {spotlight.jobCard.incentiveLedger.incentiveVerifiedAt ? (
                    <p className="text-[var(--success)] text-xs font-medium">✓ Performance incentive verified</p>
                  ) : (
                    <button
                      type="button"
                      disabled={incentiveBusy}
                      onClick={() => void verifyPerformanceIncentive(spotlight.jobCard.id)}
                      className="px-3 py-1.5 rounded-ds-sm bg-[var(--success)] hover:opacity-90 text-white text-xs font-medium disabled:opacity-50 transition-colors"
                    >
                      {incentiveBusy ? '…' : 'Verify performance incentive'}
                    </button>
                  )}
                </div>
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
            const sheetInwardQty = stageKey === 'pasting' ? pastingInboundSheets(row) : getUpstreamSheets(row)
            const upsForPasting = stageKey === 'pasting' ? pastingUps(row) : 0
            const expectedCartons = stageKey === 'pasting' ? pastingExpectedCartons(row) : 0
            const actualCartons = stageKey === 'pasting' ? completedQty : 0
            const wastageCartons =
              stageKey === 'pasting'
                ? Math.max(0, expectedCartons - actualCartons)
                : 0
            const wastageSheetsFromCartons =
              stageKey === 'pasting' && upsForPasting > 0
                ? Math.round(wastageCartons / upsForPasting)
                : 0
            const pushDraft = pushDrafts[row.stageRecord.id]
            const pushQty = pushDraft == null || pushDraft === '' ? autoFromCounter.pushQty : Number(pushDraft)
            const supervisorApprovalEnabled = getExecutionState(row).supervisorApprovalEnabled === true
            const nextKey = nextRequiredStageKey(row)
            const nextLabel = nextKey ? stageLabelForKey(nextKey) : null
            const nextStageState = nextLabel ? row.jobCard.stageMap?.[nextLabel] : null
            const nextStarted = nextStageState?.status === 'in_progress' || nextStageState?.status === 'completed'

            return (
              <div className="rounded-ds-lg bg-ds-elevated/30 px-4 py-3.5 space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--brand-primary)]">{stageMeta?.label ?? 'Stage'} Decisions</p>

                {/* ── Pasting: Expected outcome strip (shown FIRST) ── */}
                {stageKey === 'pasting' ? (
                  <div className="rounded-ds-md bg-ds-warning/5 px-3 py-2.5 space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--brand-primary)]/70">Expected Outcome</p>
                    <div className={`flex items-center gap-2 flex-wrap text-xs ${mono}`}>
                      <span className="text-ds-ink-faint">Sheets in:</span>
                      <span className="text-ds-ink font-medium">{sheetInwardQty.toLocaleString('en-IN')}</span>
                      <span className="text-ds-ink-faint">×</span>
                      <span className="text-ds-ink-faint">UPS:</span>
                      <span className="text-ds-ink font-medium">{upsForPasting > 0 ? upsForPasting : '—'}</span>
                      <span className="text-ds-warning">→</span>
                      <span className="text-ds-warning font-bold text-sm">{expectedCartons.toLocaleString('en-IN')} cartons</span>
                    </div>
                    {pushedQty > 0 && availableToPush === 0 ? (
                      <p className="text-[11px] text-[var(--success)] font-medium">✓ Fully pushed to Dispatch</p>
                    ) : null}
                  </div>
                ) : null}

                {/* ── Pasting: Actual counter (full-width, prominent) ── */}
                {stageKey === 'pasting' ? (
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-ds-ink-faint block">Actual Counter (cartons produced)</label>
                    <input
                      value={getRowCounter(row)}
                      onChange={(e) => {
                        const nextRaw = e.target.value
                        setCounterDrafts((prev) => ({ ...prev, [row.stageRecord.id]: nextRaw }))
                        const auto = computeAutoFromCounter(row, nextRaw)
                        setPushDrafts((prev) => ({ ...prev, [row.stageRecord.id]: String(auto.pushQty) }))
                        setWastageDrafts((prev) => ({ ...prev, [row.stageRecord.id]: String(auto.wastage) }))
                      }}
                      className={`w-full rounded-ds-md bg-ds-card px-3 py-2.5 text-right text-xl font-bold text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-warning/40 ${mono}`}
                      placeholder="0"
                      inputMode="numeric"
                    />
                  </div>
                ) : (
                  /* ── Non-pasting: standard 2-col grid ── */
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="space-y-1">
                      <span className="text-ds-ink-faint">Operator</span>
                      {stationOperators.length > 0 ? (
                        <select
                          value={getRowOperator(row)}
                          onChange={(e) => setOperatorDrafts((prev) => ({ ...prev, [row.stageRecord.id]: e.target.value }))}
                          className="w-full rounded bg-ds-card px-2 py-1 text-xs text-ds-ink"
                        >
                          <option value="">Select operator</option>
                          {stationOperators.map((op) => (
                            <option key={op.id} value={op.name}>{op.name}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={getRowOperator(row)}
                          onChange={(e) => setOperatorDrafts((prev) => ({ ...prev, [row.stageRecord.id]: e.target.value }))}
                          placeholder="Operator"
                          className="w-full rounded bg-ds-card px-2 py-1 text-xs text-ds-ink"
                        />
                      )}
                    </label>
                    {terminalRule.machineAutoFromOperator ? (
                      <label className="space-y-1">
                        <span className="text-ds-ink-faint">Machine</span>
                        <div className="w-full rounded bg-ds-card/60 px-2 py-1 text-xs text-ds-ink">
                          {resolvePrintingMachine(getRowOperator(row)) ?? '—'} <span className="text-ds-ink-faint">(auto)</span>
                        </div>
                      </label>
                    ) : terminalRule.fixedMachineCode ? (
                      <label className="space-y-1">
                        <span className="text-ds-ink-faint">Machine</span>
                        <div className="w-full rounded bg-ds-card/60 px-2 py-1 text-xs text-ds-ink">
                          {terminalRule.fixedMachineCode} <span className="text-ds-ink-faint">(fixed)</span>
                        </div>
                      </label>
                    ) : terminalRule.machineSelectable && terminalRule.machineCodes.length > 0 ? (
                      <label className="space-y-1">
                        <span className="text-ds-ink-faint">Machine</span>
                        <select
                          value={getRowMachine(row)}
                          onChange={(e) => setMachineDrafts((prev) => ({ ...prev, [row.stageRecord.id]: e.target.value }))}
                          className="w-full rounded bg-ds-card px-2 py-1 text-xs text-ds-ink"
                        >
                          <option value="">Select machine</option>
                          {terminalRule.machineCodes.map((mc) => (
                            <option key={mc} value={mc}>{mc}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
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
                        className={`w-full rounded bg-ds-card px-2 py-1 text-right text-xs text-ds-ink ${mono}`}
                        placeholder="0"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-ds-ink-faint">Push Qty</span>
                      <input
                        value={pushDrafts[row.stageRecord.id] ?? String(autoFromCounter.pushQty)}
                        onChange={(e) => setPushDrafts((prev) => ({ ...prev, [row.stageRecord.id]: e.target.value }))}
                        className={`w-full rounded bg-ds-card px-2 py-1 text-right text-xs text-ds-ink ${mono}`}
                        placeholder={String(autoFromCounter.pushQty)}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-ds-ink-faint">Wastage Qty</span>
                      <input
                        value={wastageDrafts[row.stageRecord.id] ?? String(computeAutoFromCounter(row, getRowCounter(row)).wastage)}
                        readOnly
                        className={`w-full rounded bg-ds-card px-2 py-1 text-right text-xs text-ds-ink ${mono}`}
                        placeholder="0"
                      />
                    </label>
                  </div>
                )}

                {/* ── Pasting: computed results row ── */}
                {stageKey === 'pasting' && Number(getRowCounter(row)) > 0 ? (
                  <div className={`grid grid-cols-3 gap-2 text-xs ${mono}`}>
                    <div className="rounded-ds-md bg-ds-card/60 px-2.5 py-2 text-center">
                      <p className="text-ds-ink-faint text-[10px] mb-0.5">Push Qty</p>
                      <p className="text-ds-ink font-semibold">{autoFromCounter.pushQty.toLocaleString('en-IN')}</p>
                    </div>
                    <div className={`rounded-ds-md px-2.5 py-2 text-center ${wastageCartons > 0 ? 'bg-[var(--error-bg)]' : 'bg-ds-card/60'}`}>
                      <p className="text-ds-ink-faint text-[10px] mb-0.5">Wastage (cartons)</p>
                      <p className={wastageCartons > 0 ? 'text-[var(--error)] font-semibold' : 'text-ds-ink font-semibold'}>{wastageCartons.toLocaleString('en-IN')}</p>
                    </div>
                    <div className={`rounded-ds-md px-2.5 py-2 text-center ${wastageSheetsFromCartons > 0 ? 'bg-[var(--error-bg)]' : 'bg-ds-card/60'}`}>
                      <p className="text-ds-ink-faint text-[10px] mb-0.5">Wastage (sheets)</p>
                      <p className={wastageSheetsFromCartons > 0 ? 'text-[var(--error)] font-semibold' : 'text-ds-ink font-semibold'}>{upsForPasting > 0 ? wastageSheetsFromCartons.toLocaleString('en-IN') : '—'}</p>
                    </div>
                  </div>
                ) : null}

                {/* ── Pasting: operator + machine (secondary, below numbers) ── */}
                {stageKey === 'pasting' ? (
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-xs">
                      <span className="text-ds-ink-faint w-16 shrink-0">Operator</span>
                      {stationOperators.length > 0 ? (
                        <select
                          value={getRowOperator(row)}
                          onChange={(e) => setOperatorDrafts((prev) => ({ ...prev, [row.stageRecord.id]: e.target.value }))}
                          className="flex-1 rounded bg-ds-card px-2 py-1 text-xs text-ds-ink"
                        >
                          <option value="">Select operator</option>
                          {stationOperators.map((op) => (
                            <option key={op.id} value={op.name}>{op.name}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={getRowOperator(row)}
                          onChange={(e) => setOperatorDrafts((prev) => ({ ...prev, [row.stageRecord.id]: e.target.value }))}
                          placeholder="Operator"
                          className="flex-1 rounded bg-ds-card px-2 py-1 text-xs text-ds-ink"
                        />
                      )}
                    </label>
                    {terminalRule.machineSelectable && terminalRule.machineCodes.length > 0 ? (
                      <label className="flex items-center gap-2 text-xs">
                        <span className="text-ds-ink-faint w-16 shrink-0">Machine</span>
                        <select
                          value={getRowMachine(row)}
                          onChange={(e) => setMachineDrafts((prev) => ({ ...prev, [row.stageRecord.id]: e.target.value }))}
                          className="flex-1 rounded bg-ds-card px-2 py-1 text-xs text-ds-ink"
                        >
                          <option value="">Select machine</option>
                          {terminalRule.machineCodes.map((mc) => (
                            <option key={mc} value={mc}>{mc}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                ) : null}

                {/* ── Status line ── */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ds-ink-faint">
                  <span>Status: <span className="text-ds-ink capitalize">{currentStatus}</span></span>
                  {stageKey !== 'pasting' ? (
                    <span>Available to push: <span className={mono}>{availableToPush.toLocaleString('en-IN')}</span></span>
                  ) : null}
                  {nextLabel ? (
                    <span>Next: <span className="text-ds-ink">{nextLabel}</span></span>
                  ) : stageKey === 'pasting' ? (
                    <span className="text-[var(--success)] font-medium">→ Ready for Dispatch</span>
                  ) : null}
                </div>
                {/* ── Actions ── */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {currentStatus === 'completed' ? (
                    <>
                      <button
                        type="button"
                        disabled={savingStageId === row.stageRecord.id || !!nextStarted}
                        onClick={() => void saveStageInline(row, { status: 'pending' })}
                        className="rounded-ds-sm bg-ds-elevated px-3 py-1.5 text-xs text-ds-ink-muted hover:text-ds-warning disabled:opacity-40 transition-colors"
                        title={nextStarted ? 'Next station already started' : 'Reopen this stage'}
                      >
                        Reopen
                      </button>
                      {nextKey ? (
                        <Link
                          href={`/production/stages/${nextKey}`}
                          className="rounded-ds-sm bg-ds-elevated px-3 py-1.5 text-xs text-ds-ink hover:text-ds-warning transition-colors"
                        >
                          View Next Stage →
                        </Link>
                      ) : stageKey === 'pasting' ? (
                        <Link
                          href="/dispatch"
                          className="rounded-ds-sm bg-[var(--success-bg)] px-3 py-1.5 text-xs text-[var(--success)] hover:bg-[var(--success-bg)]/80 transition-colors font-medium"
                        >
                          Go to Dispatch →
                        </Link>
                      ) : null}
                    </>
                  ) : (
                    <>
                      {(() => {
                        const _operatorOk = !terminalRule.operatorRequired || !!getRowOperator(row).trim()
                        const _machineOk = !terminalRule.machineRequired || !!effMachineForRow(row)
                        const _rulesMet = _operatorOk && _machineOk
                        return currentStatus !== 'in_progress' ? (
                          <button
                            type="button"
                            disabled={savingStageId === row.stageRecord.id || !_rulesMet}
                            onClick={() => void saveStageInline(row, { status: 'in_progress' })}
                            className="rounded-ds-sm bg-ds-warning px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-opacity"
                            title={!_rulesMet ? (!_operatorOk ? 'Select operator first' : 'Select machine first') : undefined}
                          >
                            Start Production
                          </button>
                        ) : null
                      })()}
                      {availableToPush > 0 ? (
                        <button
                          type="button"
                          disabled={savingStageId === row.stageRecord.id || !Number.isFinite(pushQty) || pushQty <= 0 || pushQty > availableToPush}
                          onClick={() => void pushToNext(row, pushQty, false)}
                          className="rounded-ds-sm bg-ds-warning/10 px-3 py-1.5 text-xs text-ds-warning hover:bg-ds-warning/15 disabled:opacity-40 transition-colors"
                        >
                          Partial Push
                        </button>
                      ) : null}
                      {supervisorApprovalEnabled ? (
                        <>
                          <button
                            type="button"
                            disabled={savingStageId === row.stageRecord.id}
                            onClick={() => void setApproval(row, 'approved', null)}
                            className="rounded-ds-sm bg-[var(--tooling-bg,rgba(124,58,237,0.12))] px-3 py-1.5 text-xs text-[var(--tooling,#7c3aed)] hover:bg-[var(--tooling-bg,rgba(124,58,237,0.18))] disabled:opacity-40 transition-colors"
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
                            className="rounded-ds-sm bg-[var(--tooling-bg,rgba(124,58,237,0.12))] px-3 py-1.5 text-xs text-[var(--tooling,#7c3aed)] hover:bg-[var(--tooling-bg,rgba(124,58,237,0.18))] disabled:opacity-40 transition-colors"
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
                        onClick={() => {
                          if (stageKey === 'pasting') {
                            // Pasting is terminal → open the packing manifest drawer so the
                            // operator records boxes × qty/box before pushing to Dispatch.
                            const existingProgress = getStageProgress(row) as StageProgress & {
                              packingConfig?: unknown
                            }
                            const existing = normalizePackingConfig(existingProgress.packingConfig)
                            setPastingPackDraft({
                              row,
                              packing: existing.length ? existing : [{ boxes: 0, qtyPerBox: 0 }],
                            })
                          } else {
                            void completeAndPushNext(row)
                          }
                        }}
                        className="rounded-ds-sm bg-ds-warning px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-opacity"
                      >
                        {stageKey === 'pasting' ? 'Complete & Pack →' : 'Complete Push'}
                      </button>
                      {pushedQty > 0 ? (
                        <button
                          type="button"
                          disabled={savingStageId === row.stageRecord.id}
                          onClick={() => void bringBackFromNextStage(row)}
                          className="rounded-ds-sm bg-ds-elevated px-3 py-1.5 text-xs text-ds-ink-muted hover:text-ds-warning disabled:opacity-40 transition-colors"
                        >
                          Undo Last Push
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={savingStageId === row.stageRecord.id}
                        onClick={() => void sendRework(row)}
                        className="rounded-ds-sm bg-[var(--error-bg)] px-3 py-1.5 text-xs text-[var(--error)] hover:bg-[var(--error-bg)]/80 disabled:opacity-40 transition-colors"
                      >
                        Send Rework
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })()}
          <div className="rounded-ds-lg bg-ds-elevated/30 px-4 py-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--brand-primary)] mb-3">Quality Checkpoint</p>
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
                      className="rounded-ds-sm bg-ds-elevated px-2.5 py-0.5 text-[11px] text-ds-ink-muted hover:text-ds-warning transition-colors"
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
                      className="rounded-ds-sm bg-ds-elevated px-2.5 py-0.5 text-[11px] text-ds-ink-muted hover:text-[var(--error)] transition-colors"
                      onClick={() =>
                        setChecklistDrafts((prev) => ({
                          ...prev,
                          [spotlight.stageRecord.id]: Object.fromEntries(keys.map((k) => [k, false])),
                        }))
                      }
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )
            })()}
            <div className="grid grid-cols-1 gap-2">
              {stationChecklistKeys(stageKey).map((item) => {
                const current = checklistDrafts[spotlight.stageRecord.id]?.[item] === true
                return (
                  <label
                    key={item}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-ds-md px-3 py-2 text-xs transition-colors ${
                      current
                        ? 'bg-[var(--success-bg)] text-[var(--success)]'
                        : 'bg-ds-elevated/40 text-ds-ink hover:bg-ds-elevated'
                    }`}
                  >
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
                      className="h-3.5 w-3.5 accent-ds-warning"
                    />
                    <span className="capitalize">{item}</span>
                  </label>
                )
              })}
            </div>
            <p className="mt-2.5 text-[11px] text-ds-ink-faint">
              All checks required before Complete Push.
            </p>
          </div>
          <div className="rounded-ds-lg bg-ds-elevated/30 px-4 py-3.5">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-ds-ink-faint">Downtime</p>
              <button
                type="button"
                onClick={() => setShowDowntime((v) => !v)}
                className="rounded-ds-sm bg-ds-elevated px-2.5 py-0.5 text-[11px] text-ds-ink-muted hover:text-ds-warning transition-colors"
              >
                {showDowntime ? 'Collapse' : 'Log Downtime'}
              </button>
            </div>
            {showDowntime ? (
              <>
            <button
              type="button"
              className="rounded bg-ds-elevated px-2 py-1 text-xs hover:bg-ds-card"
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
          <div className="rounded-ds-lg bg-ds-elevated/30 px-4 py-3.5">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-ds-ink-faint">Production Timeline</p>
              <button
                type="button"
                onClick={() => setShowTimeline((v) => !v)}
                className="rounded-ds-sm bg-ds-elevated px-2.5 py-0.5 text-[11px] text-ds-ink-muted hover:text-ds-warning transition-colors"
              >
                {showTimeline ? 'Collapse' : 'Show'}
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
    {/* Pasting → Dispatch packing manifest drawer */}
    <SlideOverPanel
      isOpen={!!pastingPackDraft}
      onClose={() => (pastingPackSaving ? undefined : setPastingPackDraft(null))}
      title={
        pastingPackDraft
          ? `Confirm Packing · JC-${pastingPackDraft.row.jobCard.jobCardNumber}`
          : ''
      }
      headerMeta={
        pastingPackDraft
          ? `${pastingPackDraft.row.jobCard.customer?.name ?? '—'} · ${pastingPackDraft.row.jobCard.productName ?? pastingPackDraft.row.jobCard.setNumber ?? '—'}`
          : undefined
      }
      footer={
        pastingPackDraft ? (
          <div className="flex items-center gap-2">
            <DsButton
              variant="primary"
              className="flex-1 gap-2"
              disabled={pastingPackSaving}
              onClick={async () => {
                if (!pastingPackDraft) return
                setPastingPackSaving(true)
                try {
                  await completePastingTerminal(pastingPackDraft.row, pastingPackDraft.packing)
                  setPastingPackDraft(null)
                } finally {
                  setPastingPackSaving(false)
                }
              }}
            >
              {pastingPackSaving ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Package className="h-4 w-4" />
              )}
              {pastingPackSaving ? 'Completing…' : 'Complete & Push to Dispatch'}
            </DsButton>
            <DsButton
              variant="secondary"
              disabled={pastingPackSaving}
              onClick={() => setPastingPackDraft(null)}
            >
              Cancel
            </DsButton>
          </div>
        ) : null
      }
    >
      {pastingPackDraft && (
        <div className="space-y-4">
          <div className="space-y-3 rounded-ds-md bg-[var(--brand-bg-soft)] px-4 py-3.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--brand-primary)]">
              Job Card Summary
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {(() => {
                const r = pastingPackDraft.row
                const counter = Number(getRowCounter(r) || 0)
                const poMeta = r.jobCard.poMeta
                const poQty = poMeta?.quantity ?? null
                return (
                  <>
                    <div className="text-ds-ink-muted">PO Number</div>
                    <div className="font-mono text-ds-ink">{poMeta?.poNumber ?? '—'}</div>
                    <div className="text-ds-ink-muted">Customer PO Qty</div>
                    <div className="tabular-nums text-ds-ink">
                      {poQty != null ? poQty.toLocaleString('en-IN') : '—'}
                    </div>
                    <div className="text-ds-ink-muted">Pasting Counter</div>
                    <div className="font-semibold tabular-nums text-ds-ink">
                      {counter.toLocaleString('en-IN')}
                    </div>
                  </>
                )
              })()}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-muted">
              Packing Manifest
            </div>
            <PackingConfigEditor
              value={pastingPackDraft.packing}
              onChange={(next) =>
                setPastingPackDraft((prev) => (prev ? { ...prev, packing: next } : prev))
              }
              referenceQty={Number(getRowCounter(pastingPackDraft.row) || 0)}
              referenceLabel="Pasting Counter"
              disabled={pastingPackSaving}
            />
            <p className="px-1 text-[11px] leading-relaxed text-ds-ink-faint">
              Capture how the finished cartons are packed. Multiple rows allowed (e.g. 4 boxes × 3000 + 2 boxes × 1000). This manifest flows into the Dispatch row and the customer’s delivery challan.
            </p>
          </div>
        </div>
      )}
    </SlideOverPanel>
    </>
  )
}
