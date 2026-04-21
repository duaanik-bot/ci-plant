'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Download, Star } from 'lucide-react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { isEmbossingRequired } from '@/lib/emboss-conditions'
import { mergeOrchestrationIntoSpec, PLANNING_FLOW } from '@/lib/orchestration-spec'
import {
  computeSheetUtilization,
  formatSheetSizeMm,
  generateMasterSetId,
  PLANNING_DESIGNERS,
  readPlanningCore,
  suggestNextAutoSetNumber,
  type PlanningCore,
  type PlanningDesignerKey,
  type PlanningSetIdMode,
} from '@/lib/planning-decision-spec'
import { PlanningReadinessDrawer } from '@/components/planning/PlanningReadinessDrawer'
import {
  PlanningDecisionLayerToolbar,
  type PlanningGroupBy,
} from '@/components/planning/PlanningDecisionLayerToolbar'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'
import {
  INDUSTRIAL_PRIORITY_ROW_CLASS,
  INDUSTRIAL_PRIORITY_STAR_ICON_CLASS,
} from '@/lib/industrial-priority-ui'
import {
  aggregatePlanningBlockers,
  computeJobRunHours,
  computeMachineLoadPct,
  formatDurationHMM,
  pickBestMachineId,
  sheetsEstimateForLine,
  type BlockerCategory,
} from '@/lib/planning-analytics'
import {
  computeFivePointReadiness,
  firstFivePointBlockerName,
  type ReadinessFiveSegment,
} from '@/lib/planning-interlock'
import { ProductionScheduleBoard } from '@/components/planning/ProductionScheduleBoard'
import { parseCellKey, type ScheduleHandshake } from '@/lib/production-schedule-spec'

type PlanningSpec = {
  machineId?: string
  shift?: string
  plannedDate?: string
  artworkLocksCompleted?: number
  platesStatus?: 'available' | 'partial' | 'new_required'
  dieStatus?: 'good' | 'attention' | 'not_available'
  embossStatus?: 'ready' | 'vendor_ordered' | 'na'
  numberOfColours?: number
  planningGanttIndex?: number
  planningProjectedFinishAt?: string | null
  prodScheduleSlot?: { machineId: string; shift: 1 | 2 | 3; order: number }
  scheduleHandshake?: ScheduleHandshake
  planningCore?: PlanningCore
  /** Denormalized for AW filters */
  planningDesignerDisplayName?: string
}

type InterlockSegment = {
  key: string
  label: string
  ok: boolean
  na?: boolean
  hint?: string
}

type MaterialGate = {
  status: 'unknown' | 'available' | 'ordered' | 'shortage'
  requiredSheets: number | null
  netAvailable: number | null
  procurementStatus: string
}

type PlanningLedger = {
  toolingInterlock: { segments: InterlockSegment[]; allReady: boolean }
  materialGate: MaterialGate
  suggestedMachineId: string | null
  estimatedDurationHours: number
  numberOfColours: number | null
  readinessFive?: { segments: ReadinessFiveSegment[]; allGreen: boolean }
}

type Line = {
  id: string
  cartonId: string | null
  dimLengthMm?: unknown
  dimWidthMm?: unknown
  cartonName: string
  cartonSize: string | null
  quantity: number
  rate: number | null
  gsm: number | null
  coatingType: string | null
  embossingLeafing: string | null
  paperType: string | null
  dyeId: string | null
  remarks: string | null
  setNumber: string | null
  jobCardNumber: number | null
  planningStatus: string
  specOverrides: PlanningSpec | null
  po: {
    id: string
    poNumber: string
    status: string
    poDate: string
    isPriority?: boolean
    customer: { id: string; name: string }
  }
  jobCard?: {
    id: string
    jobCardNumber: number
    artworkApproved: boolean
    firstArticlePass: boolean
    finalQcPass: boolean
    qaReleased: boolean
    plateSetId: string | null
    status: string
    issuedStockDisplay?: string | null
    grainFitStatus?: string
    inventoryLocationPointer?: string | null
    sheetsIssued?: number
    totalSheets?: number
    stages?: { stageName: string; counter: number | null }[]
    allocatedPaperWarehouse?: { lotNumber: string | null } | null
  } | null
  readiness?: {
    artworkLocksCompleted: number
    platesStatus: string
    dieStatus: string
    machineAllocated: boolean
  }
  directorPriority?: boolean
  directorHold?: boolean
  planningLedger?: PlanningLedger
  materialQueue?: {
    totalSheets: number
    ups?: number
    boardType?: string
    gsm?: number
    sheetLengthMm?: unknown
    sheetWidthMm?: unknown
  } | null
  materialProcurementStatus?: string
  shadeCardId?: string | null
  shadeCard?: {
    custodyStatus: string
    mfgDate: string | null
    approvalDate: string | null
    createdAt: string
    isActive: boolean
  } | null
  carton?: {
    blankLength?: unknown
    blankWidth?: unknown
  } | null
  createdAt?: string
}

type Customer = { id: string; name: string; contactName?: string | null }
type Machine = {
  id: string
  machineCode: string
  name: string
  stdWastePct: number | null
  capacityPerShift: number
  specification?: string | null
}

const PLANNING_STATUSES = [
  'pending',
  'planned',
  'design_ready',
  'job_card_created',
  'in_production',
  'closed',
] as const

const SHIFTS = ['A', 'B', 'C'] as const

const mono = 'font-designing-queue tabular-nums tracking-tight'

function shadeCardForInterlock(r: Line): {
  custodyStatus: string
  mfgDate: Date | null
  approvalDate: Date | null
  createdAt: Date
  isActive: boolean
} | null {
  if (!r.shadeCard) return null
  const c = r.shadeCard
  return {
    custodyStatus: c.custodyStatus,
    mfgDate: c.mfgDate ? new Date(c.mfgDate) : null,
    approvalDate: c.approvalDate ? new Date(c.approvalDate) : null,
    createdAt: new Date(c.createdAt),
    isActive: c.isActive,
  }
}

function readinessFiveForLine(r: Line): { segments: ReadinessFiveSegment[]; allGreen: boolean } {
  const spec = r.specOverrides || {}
  const artworkLocks = Number(spec.artworkLocksCompleted ?? r.readiness?.artworkLocksCompleted ?? 0)
  const platesStatus = String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required')
  const dieStatus = String(spec.dieStatus ?? r.readiness?.dieStatus ?? (r.dyeId ? 'good' : 'not_available'))
  const embossStatus = String(spec.embossStatus ?? 'vendor_ordered')
  const materialGate =
    r.planningLedger?.materialGate ?? {
      status: 'unknown' as const,
      requiredSheets: null,
      netAvailable: null,
      procurementStatus: '',
    }
  return computeFivePointReadiness({
    artworkLocksCompleted: artworkLocks,
    platesStatus,
    materialGate,
    dieStatus,
    embossingLeafing: r.embossingLeafing,
    embossStatus,
    shadeCardId: r.shadeCardId ?? null,
    shadeCard: shadeCardForInterlock(r),
  })
}

function ReadinessFiveBar({ segments }: { segments: ReadinessFiveSegment[] }) {
  return (
    <div className="flex items-center gap-0.5" aria-label="Readiness interlock AW · PA · DI · EB · SC">
      {segments.map((s) => {
        const green = s.state === 'ready'
        const grey = s.state === 'neutral'
        const blocked = s.state === 'blocked'
        return (
          <span
            key={s.key}
            title={s.title}
            className={`inline-flex h-6 w-[1.35rem] shrink-0 cursor-help items-center justify-center rounded text-[8px] font-bold leading-none ${mono} ${
              green
                ? 'border border-emerald-500/45 bg-emerald-500/12 text-emerald-300'
                : grey
                  ? 'border border-white/10 bg-zinc-900 text-zinc-500'
                  : 'border border-rose-500 bg-rose-500/10 text-rose-100 shadow-[0_0_0_1px_rgba(244,63,94,0.55),0_0_10px_rgba(244,63,94,0.25)]'
            } ${blocked ? 'ring-1 ring-rose-500/35' : ''}`}
          >
            {s.abbr}
          </span>
        )
      })}
    </div>
  )
}

function ReadinessGauge({ pct }: { pct: number }) {
  const p = Math.min(100, Math.max(0, Math.round(pct * 10) / 10))
  const r = 15.9155
  const c = 2 * Math.PI * r
  const dash = (p / 100) * c
  return (
    <div className="relative h-[4.25rem] w-[4.25rem] shrink-0" aria-hidden>
      <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" className="stroke-zinc-800" strokeWidth="2.2" />
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          className="stroke-emerald-500"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
        />
      </svg>
      <div
        className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center ${mono}`}
      >
        <span className="text-sm font-semibold tabular-nums text-emerald-400">{p}%</span>
        <span className="text-[7px] font-medium uppercase tracking-wider text-slate-500">ratio</span>
      </div>
    </div>
  )
}

function csvEscapeCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

/** 0–100: five interlock icons + plates + machine (7 weights). */
function readinessScorePercent(r: Line): number {
  const five = readinessFiveForLine(r)
  const spec = r.specOverrides || {}
  let score = 0
  for (const s of five.segments) {
    if (s.state === 'ready' || (s.state === 'neutral' && s.key === 'eb')) score += 1
  }
  const platesOk = String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required') === 'available'
  if (platesOk) score += 1
  if (String(spec.machineId ?? '').trim()) score += 1
  return Math.round((score / 7) * 1000) / 10
}

function downloadPlanningAuditCsv(rows: Line[]) {
  const header = [
    'PO_Number',
    'Customer',
    'Readiness_Score',
    'Primary_Blocker',
    'Days_in_Queue',
    'Planned_vs_Actual',
    'JC_Material_Batch_Lot',
    'JC_Material_Usage_Line',
    'JC_Grain_Fit_Status',
    'JC_Location_Pointer',
  ]
  const lines: string[] = [header.join(',')]
  const now = Date.now()
  for (const r of rows) {
    const five = readinessFiveForLine(r)
    const spec = r.specOverrides || {}
    const platesSt = String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required')
    const blocker =
      firstFivePointBlockerName(five.segments, platesSt) ??
      (!String(spec.machineId ?? '').trim() ? 'Machine' : '')
    const days =
      r.createdAt != null
        ? String(Math.max(0, Math.floor((now - new Date(r.createdAt).getTime()) / 86_400_000)))
        : ''
    const planned = spec.plannedDate?.trim() ?? ''
    const actual = r.jobCard?.id ? `JC#${r.jobCard.jobCardNumber}` : 'Pending'
    const pva = planned ? `${planned}|${actual}` : `—|${actual}`
    const jc = r.jobCard
    const matLot = jc?.allocatedPaperWarehouse?.lotNumber?.trim() || '—'
    const matLine = jc?.issuedStockDisplay?.trim() || '—'
    const grainFit = jc?.grainFitStatus?.trim() || '—'
    const locPtr = jc?.inventoryLocationPointer?.trim() || '—'
    lines.push(
      [
        csvEscapeCell(r.po.poNumber),
        csvEscapeCell(r.po.customer.name),
        csvEscapeCell(String(readinessScorePercent(r))),
        csvEscapeCell(blocker || '—'),
        csvEscapeCell(days),
        csvEscapeCell(pva),
        csvEscapeCell(matLot),
        csvEscapeCell(matLine),
        csvEscapeCell(grainFit),
        csvEscapeCell(locPtr),
      ].join(','),
    )
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `planning-audit-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function lineIndustrialPriority(l: Line): boolean {
  return l.po.isPriority === true || l.directorPriority === true
}

function buildLaneMapFromRows(rows: Line[]): Record<string, string[]> {
  const byM: Record<string, Line[]> = {}
  for (const r of rows) {
    const mid = r.specOverrides?.machineId?.trim()
    if (!mid || r.planningStatus === 'closed') continue
    if (!byM[mid]) byM[mid] = []
    byM[mid].push(r)
  }
  const out: Record<string, string[]> = {}
  for (const [mid, list] of Object.entries(byM)) {
    list.sort((a, b) => {
      const ia = a.specOverrides?.planningGanttIndex
      const ib = b.specOverrides?.planningGanttIndex
      if (ia != null || ib != null) return (ia ?? 1e6) - (ib ?? 1e6)
      const pa = lineIndustrialPriority(a) ? 1 : 0
      const pb = lineIndustrialPriority(b) ? 1 : 0
      if (pa !== pb) return pb - pa
      return new Date(b.po.poDate).getTime() - new Date(a.po.poDate).getTime()
    })
    out[mid] = list.map((l) => l.id)
  }
  return out
}

function materialBadgeClass(g: MaterialGate): string {
  switch (g.status) {
    case 'available':
      return 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40'
    case 'ordered':
      return 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/40'
    case 'shortage':
      return 'bg-red-500/20 text-red-200 ring-1 ring-red-500/50 animate-pulse'
    default:
      return 'bg-slate-800 text-slate-400 ring-1 ring-white/10'
  }
}

function materialBadgeLabel(g: MaterialGate): string {
  if (g.status === 'unknown') return 'MRP —'
  if (g.status === 'available') return 'Stock OK'
  if (g.status === 'ordered') return 'On order'
  return 'Shortage'
}

export default function PlanningPage() {
  const [rows, setRows] = useState<Line[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)
  const [planningStatus, setPlanningStatus] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [queueTab, setQueueTab] = useState<'all' | 'ready' | 'awaiting_tools' | 'awaiting_artwork'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [integrityFooter, setIntegrityFooter] = useState<string | null>(null)
  const [selectedBlocker, setSelectedBlocker] = useState<BlockerCategory | null>(null)
  const [bottleneckBreakdownOpen, setBottleneckBreakdownOpen] = useState(false)
  const [planningSelection, setPlanningSelection] = useState<Set<string>>(new Set())
  const [planningGroupBy, setPlanningGroupBy] = useState<PlanningGroupBy>('none')
  const [planningSetIdMode, setPlanningSetIdMode] = useState<PlanningSetIdMode>('auto')
  const [planningDrawerLineId, setPlanningDrawerLineId] = useState<string | null>(null)
  const [savingPlanningHandoff, setSavingPlanningHandoff] = useState(false)

  const customerSearch = useAutoPopulate<Customer>({
    storageKey: 'planning-customer',
    search: async (query: string) => {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(query)}`)
      return (await res.json()) as Customer[]
    },
    getId: (c) => c.id,
    getLabel: (c) => c.name,
  })

  const applyCustomer = (c: Customer | null) => {
    if (c) {
      customerSearch.select(c)
      setCustomerId(c.id)
    } else {
      customerSearch.setQuery('')
      setCustomerId('')
    }
  }

  const fetchRows = useCallback(async () => {
    const params = new URLSearchParams()
    if (planningStatus) params.set('planningStatus', planningStatus)
    if (customerId) params.set('customerId', customerId)
    const res = await fetch(`/api/planning/po-lines?${params}`)
    const json = await res.json()
    const list = Array.isArray(json) ? (json as Line[]) : []
    setRows(
      list.map((li) => ({
        ...li,
        specOverrides:
          li.specOverrides && typeof li.specOverrides === 'object'
            ? (li.specOverrides as PlanningSpec)
            : null,
      })),
    )
  }, [planningStatus, customerId])

  useEffect(() => {
    async function load() {
      try {
        const machRes = await fetch('/api/machines')
        const machJson = await machRes.json()
        setMachines(
          Array.isArray(machJson)
            ? machJson.map((m: Machine) => ({
                ...m,
                capacityPerShift: Number(m.capacityPerShift) || 4000,
              }))
            : [],
        )
        await fetchRows()
      } catch {
        toast.error('Failed to load planning queue')
      } finally {
        setLoading(false)
      }
    }
    setLoading(true)
    load()
  }, [fetchRows])

  const fetchRowsRef = useRef(fetchRows)
  fetchRowsRef.current = fetchRows
  useEffect(() => {
    const onPri = () => {
      void fetchRowsRef.current()
    }
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [])

  const laneMap = useMemo(() => buildLaneMapFromRows(rows), [rows])

  const scheduleSyncSignature = useMemo(
    () =>
      rows
        .map((r) => {
          const s = r.specOverrides || {}
          return `${r.id}:${JSON.stringify(s.prodScheduleSlot ?? null)}:${JSON.stringify(s.scheduleHandshake ?? null)}`
        })
        .sort()
        .join('|'),
    [rows],
  )

  const scheduledHoursByMachine = useMemo(() => {
    const out: Record<string, number> = {}
    for (const m of machines) {
      const ids = laneMap[m.id] ?? []
      let h = 0
      for (const id of ids) {
        const r = rows.find((x) => x.id === id)
        if (!r) continue
        const sheets = sheetsEstimateForLine({
          quantity: r.quantity,
          materialQueueTotalSheets: r.materialQueue?.totalSheets ?? null,
        })
        h += computeJobRunHours({
          sheets,
          capacityPerShift: m.capacityPerShift ?? 4000,
        })
      }
      out[m.id] = h
    }
    return out
  }, [laneMap, machines, rows])

  const blockerData = useMemo(() => aggregatePlanningBlockers(rows), [rows])
  const pieData = useMemo(
    () => blockerData.map((b) => ({ name: b.label, value: b.count, key: b.key })),
    [blockerData],
  )

  const machineLoadPct = useMemo(() => {
    const H = 7 * 24
    const o: Record<string, number> = {}
    for (const m of machines) {
      o[m.id] = computeMachineLoadPct({
        scheduledHours: scheduledHoursByMachine[m.id] ?? 0,
        horizonHours: H,
      })
    }
    return o
  }, [machines, scheduledHoursByMachine])

  const readyToScheduleCount = useMemo(
    () =>
      rows.filter((r) => r.planningStatus !== 'closed' && readinessFiveForLine(r).allGreen).length,
    [rows],
  )

  const topBlockerTile = useMemo(() => {
    const b = blockerData[0]
    if (!b || b.count === 0) {
      return { headline: 'No dominant bottleneck', sub: 'Queue clear' }
    }
    return {
      headline: `${b.label} delaying ${b.count} jobs`,
      sub: `${b.count} line(s) waiting on ${b.label.toLowerCase()}`,
    }
  }, [blockerData])

  const primaryBottleneckInsight = useMemo(() => {
    if (rows.length === 0) {
      return {
        pct: 0,
        label: null as string | null,
        line: 'No lines in queue',
      }
    }
    const top = blockerData[0]
    if (!top || top.count === 0) {
      return { pct: 0, label: null, line: 'No dominant bottleneck — flow clear' }
    }
    const pct = Math.min(100, Math.round((top.count / rows.length) * 100))
    return {
      pct,
      label: top.label,
      line: `${pct}% waiting on ${top.label.toLowerCase()} · ${top.count}/${rows.length} lines`,
    }
  }, [blockerData, rows.length])

  const applySmartMachine = (r: Line) => {
    const best = pickBestMachineId(
      machines.map((m) => ({
        id: m.id,
        machineCode: m.machineCode,
        specification: m.specification ?? null,
        capacityPerShift: m.capacityPerShift ?? 4000,
      })),
      {
        colours: r.planningLedger?.numberOfColours ?? null,
        sheetLengthMm: Number(r.carton?.blankLength ?? r.dimLengthMm ?? 0) || null,
        sheetWidthMm: Number(r.carton?.blankWidth ?? r.dimWidthMm ?? 0) || null,
        scheduledHoursByMachineId: scheduledHoursByMachine,
      },
    )
    if (!best) {
      toast.error('No press available for smart assign')
      return
    }
    updateSpec(r.id, { machineId: best.id })
    toast.success(`Smart assign → ${best.machineCode}`)
  }

  const scheduleReady = useCallback((l: Line) => {
    if (l.planningStatus === 'closed') return false
    return readinessFiveForLine(l).allGreen
  }, [])

  const persistSchedule = useCallback(
    async (containers: { sidebar: string[]; cells: Record<string, string[]> }) => {
      const touched = new Set<string>()
      containers.sidebar.forEach((id) => touched.add(id))
      for (const ids of Object.values(containers.cells)) {
        for (const id of ids) touched.add(id)
      }
      for (const id of Array.from(touched)) {
        const li = rows.find((r) => r.id === id)
        if (!li) continue
        const inSidebar = containers.sidebar.includes(id)
        const spec = { ...(li.specOverrides || {}) } as Record<string, unknown>
        if (inSidebar) {
          delete spec.prodScheduleSlot
        } else {
          let placement: { machineId: string; shift: 1 | 2 | 3; order: number } | null = null
          for (const [cid, ids] of Object.entries(containers.cells)) {
            const idx = ids.indexOf(id)
            if (idx >= 0) {
              const p = parseCellKey(cid)
              if (p) placement = { machineId: p.machineId, shift: p.shift, order: idx }
              break
            }
          }
          if (placement) {
            spec.machineId = placement.machineId
            spec.shift = String(placement.shift)
            spec.prodScheduleSlot = {
              machineId: placement.machineId,
              shift: placement.shift,
              order: placement.order,
            }
          }
        }
        const res = await fetch(`/api/planning/po-lines/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specOverrides: spec }),
        })
        if (!res.ok) {
          toast.error('Could not save schedule')
          await fetchRows()
          return
        }
      }
      toast.success('Schedule saved')
      await fetchRows()
    },
    [rows, fetchRows],
  )

  const persistHandshake = useCallback(
    async (lineId: string, handshake: ScheduleHandshake) => {
      const li = rows.find((r) => r.id === lineId)
      if (!li) return
      const spec = { ...(li.specOverrides || {}), scheduleHandshake: handshake }
      const res = await fetch(`/api/planning/po-lines/${lineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specOverrides: spec }),
      })
      if (!res.ok) {
        toast.error('Handshake save failed')
        return
      }
      toast.success('Operator handshake saved')
      await fetchRows()
    },
    [rows, fetchRows],
  )

  const updateRow = (id: string, patch: Partial<Line>) => {
    setRows((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  const updateSpec = (id: string, patch: Partial<PlanningSpec>) => {
    setRows((prev) =>
      prev.map((l) =>
        l.id === id
          ? {
              ...l,
              specOverrides: { ...(l.specOverrides || {}), ...patch },
            }
          : l,
      ),
    )
  }

  const linkAsMixSet = useCallback(() => {
    if (planningSelection.size < 2) return
    const master = generateMasterSetId()
    const ids = Array.from(planningSelection)
    for (const id of ids) {
      const li = rows.find((r) => r.id === id)
      if (!li) continue
      const prev = readPlanningCore(li.specOverrides as Record<string, unknown>)
      updateSpec(id, {
        planningCore: {
          ...prev,
          masterSetId: master,
          mixSetMemberIds: ids,
          layoutType: 'gang',
        },
      })
    }
    toast.success('Mix-set linked — one Master Set ID; complete UPS & designer, then Save planning')
  }, [planningSelection, rows])

  const savePlanningHandoff = useCallback(async () => {
    const candidates = rows.filter((r) => {
      if (r.planningStatus === 'closed') return false
      const c = readPlanningCore(r.specOverrides as Record<string, unknown>)
      return !!(c.designerKey && c.ups != null && c.ups >= 1)
    })
    if (candidates.length === 0) {
      toast.error('Set designer and UPS (≥1) on each line before save')
      return
    }
    setSavingPlanningHandoff(true)
    try {
      const assignedNums: (string | null | undefined)[] = rows.map((r) => r.setNumber)
      for (const r of candidates) {
        const spec = { ...(r.specOverrides || {}) } as Record<string, unknown>
        const pc = readPlanningCore(spec)
        const designerName = pc.designerKey ? PLANNING_DESIGNERS[pc.designerKey] : ''
        let resolved = pc.resolvedSetNumber?.trim()
        if (planningSetIdMode === 'manual' && !resolved) {
          toast.error('Manual Set ID: enter Set # (expanded row) for each line')
          setSavingPlanningHandoff(false)
          return
        }
        if (!resolved) {
          resolved = suggestNextAutoSetNumber(assignedNums)
          assignedNums.push(resolved)
        }
        const merged = mergeOrchestrationIntoSpec(spec, {
          awQueueHandoffAt: new Date().toISOString(),
          planningFlowStatus: PLANNING_FLOW.in_progress,
        })
        const nextSpec: Record<string, unknown> = {
          ...merged,
          planningCore: {
            ...pc,
            savedAt: new Date().toISOString(),
            resolvedSetNumber: resolved,
            setIdMode: planningSetIdMode,
          },
          planningDesignerDisplayName: designerName,
        }
        const res = await fetch(`/api/planning/po-lines/${r.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            setNumber: resolved,
            planningStatus: 'planned',
            specOverrides: nextSpec,
            planningDecisionRevision: true,
          }),
        })
        if (!res.ok) {
          toast.error('Save planning failed')
          await fetchRows()
          return
        }
      }
      toast.success('Planning saved — AW Queue handoff enabled')
      await fetchRows()
    } finally {
      setSavingPlanningHandoff(false)
    }
  }, [rows, planningSetIdMode, fetchRows])

  const save = async (id: string) => {
    const li = rows.find((x) => x.id === id)
    if (!li) return
    setSavingId(id)
    try {
      const rawSpec = {
        ...(li.specOverrides && typeof li.specOverrides === 'object' ? li.specOverrides : {}),
      } as Record<string, unknown>
      let specOverrides: Record<string, unknown> = rawSpec
      if (String(rawSpec.machineId || '').trim()) {
        specOverrides = mergeOrchestrationIntoSpec(rawSpec, {
          planningFlowStatus: PLANNING_FLOW.in_progress,
        })
      }
      const body: Record<string, unknown> = {
        setNumber: li.setNumber,
        planningStatus: li.planningStatus,
        specOverrides,
      }
      const res = await fetch(`/api/planning/po-lines/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, planningDecisionRevision: true }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success('Planning updated')
      await fetchRows()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSavingId(null)
    }
  }

  const generateJobCard = async (r: Line) => {
    setGeneratingId(r.id)
    try {
      const res = await fetch(`/api/planning/po-lines/${r.id}/generate-job-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Generation failed')
      const jc = json as { id?: string; jobCardNumber?: number }
      toast.success(
        `Job card JC#${jc.jobCardNumber ?? '—'} created — tooling custody locked to production`,
      )
      setIntegrityFooter(
        `Planning Integrity Verified — Job ${jc.jobCardNumber ?? jc.id ?? r.id} · Zero-Error Flow Enabled.`,
      )
      await fetchRows()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generate failed')
    } finally {
      setGeneratingId(null)
    }
  }

  const canGenerateJobCard = (r: Line) => {
    if (r.directorHold) return false
    if (r.jobCard?.id || r.jobCardNumber) return false
    const spec = r.specOverrides || {}
    if (!String(spec.machineId || '').trim()) return false
    return readinessFiveForLine(r).allGreen
  }

  const assetReadinessRatio = useMemo(() => {
    if (rows.length === 0) return 0
    const ready = rows.filter((r) => canGenerateJobCard(r)).length
    return Math.round((ready / rows.length) * 1000) / 10
  }, [rows])

  const totalQty = useMemo(
    () => rows.reduce((sum, r) => sum + (r.quantity || 0), 0),
    [rows],
  )

  const tabFilteredRows = useMemo(() => {
    return rows.filter((r) => {
      const spec = r.specOverrides || {}
      const artworkLocks = Number(spec.artworkLocksCompleted ?? r.readiness?.artworkLocksCompleted ?? 0)
      const plateStatus = String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required')
      const currentDieStatus = String(spec.dieStatus ?? r.readiness?.dieStatus ?? (r.dyeId ? 'good' : 'not_available'))
      const embossRequired = isEmbossingRequired(r.embossingLeafing)
      const embossStatus = embossRequired ? String(spec.embossStatus ?? 'vendor_ordered') : 'na'
      const fiveGreen = readinessFiveForLine(r).allGreen
      const legacyToolsReady =
        artworkLocks >= 2 &&
        plateStatus === 'available' &&
        currentDieStatus === 'good' &&
        (embossStatus === 'ready' || embossStatus === 'na')
      const awaitingTools = artworkLocks >= 2 && !legacyToolsReady
      const awaitingArtwork = artworkLocks < 2
      if (queueTab === 'ready') return fiveGreen
      if (queueTab === 'awaiting_tools') return awaitingTools
      if (queueTab === 'awaiting_artwork') return awaitingArtwork
      return true
    })
  }, [rows, queueTab])

  const sortedPlanningRows = useMemo(() => {
    const list = [...tabFilteredRows]
    list.sort((a, b) => {
      const pa = lineIndustrialPriority(a) ? 1 : 0
      const pb = lineIndustrialPriority(b) ? 1 : 0
      if (pa !== pb) return pb - pa
      return new Date(b.po.poDate).getTime() - new Date(a.po.poDate).getTime()
    })
    return list
  }, [tabFilteredRows])

  const groupSortedPlanningRows = useMemo(() => {
    const list = [...sortedPlanningRows]
    if (planningGroupBy === 'cartonSize') {
      list.sort((a, b) => String(a.cartonSize ?? '').localeCompare(String(b.cartonSize ?? '')))
    } else if (planningGroupBy === 'gsm') {
      list.sort((a, b) => (a.gsm ?? 0) - (b.gsm ?? 0))
    } else if (planningGroupBy === 'coating') {
      list.sort((a, b) => String(a.coatingType ?? '').localeCompare(String(b.coatingType ?? '')))
    }
    return list
  }, [sortedPlanningRows, planningGroupBy])

  const scheduleBoardLines = useMemo(
    () => rows.filter((r) => r.planningStatus !== 'closed'),
    [rows],
  )

  const planningDrawerLine = useMemo(
    () => (planningDrawerLineId ? rows.find((r) => r.id === planningDrawerLineId) ?? null : null),
    [rows, planningDrawerLineId],
  )

  if (loading) {
    return (
      <div className={`min-h-[30vh] p-4 text-slate-500 ${mono}`}>Loading planning queue…</div>
    )
  }

  return (
    <div className="min-h-screen bg-[#000000] text-slate-200 pb-16">
      <div className="mx-auto max-w-[1600px] space-y-3 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-amber-400 sm:text-xl">Planning queue</h1>
            <p className={`text-[11px] text-slate-500 ${mono}`}>
              {rows.length} line(s) · Σ qty{' '}
              <span className="text-amber-300 font-semibold">{totalQty.toLocaleString('en-IN')}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/orders/purchase-orders"
              className="rounded-lg border border-white/15 bg-black px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/40"
            >
              Customer POs
            </Link>
            <Link
              href="/orders/designing"
              className="rounded-lg border border-white/15 bg-black px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/40"
            >
              Visual audit
            </Link>
            <Link
              href="/production/job-cards"
              className="rounded-lg border border-white/15 bg-black px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/40"
            >
              Job cards
            </Link>
            <button
              type="button"
              onClick={() => {
                downloadPlanningAuditCsv(rows)
                toast.success('Audit CSV exported')
              }}
              className={`inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-black px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/40 ${mono}`}
            >
              <Download className="h-3.5 w-3.5 text-amber-500/90" aria-hidden />
              Audit export
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 rounded-lg border border-slate-800 bg-[#000000] px-3 py-2.5">
          <div>
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>
              Total volume in queue
            </p>
            <p className={`text-xl font-semibold text-amber-300/95 ${mono}`}>
              {totalQty.toLocaleString('en-IN')}
            </p>
            <p className="text-[9px] text-slate-600">Σ qty · all lines in view</p>
          </div>
          <div className="sm:border-l sm:border-slate-800 sm:pl-3">
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>Top blocker</p>
            <p className={`text-sm font-medium text-rose-200/95 ${mono} leading-snug`}>
              {topBlockerTile.headline}
            </p>
            <p className="text-[9px] text-slate-600 mt-0.5">{topBlockerTile.sub}</p>
          </div>
          <div className="sm:border-l sm:border-slate-800 sm:pl-3">
            <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>
              Ready to schedule
            </p>
            <p className={`text-xl font-semibold text-emerald-400 ${mono}`}>{readyToScheduleCount}</p>
            <p className="text-[9px] text-slate-600">5-point interlock + plates · not closed</p>
          </div>
        </div>

        <PlanningDecisionLayerToolbar
          selectionCount={planningSelection.size}
          onLinkAsMixSet={linkAsMixSet}
          onSavePlanning={() => void savePlanningHandoff()}
          groupBy={planningGroupBy}
          onGroupByChange={setPlanningGroupBy}
          setIdMode={planningSetIdMode}
          onSetIdModeChange={setPlanningSetIdMode}
          saving={savingPlanningHandoff}
        />

        <div className="flex flex-wrap gap-2">
          {(
            [
              ['all', 'All'],
              ['ready', 'Ready to process'],
              ['awaiting_tools', 'Awaiting tools'],
              ['awaiting_artwork', 'Awaiting artwork'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setQueueTab(k)}
              className={`rounded border px-2.5 py-1 text-[11px] ${
                queueTab === k
                  ? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
                  : 'border-white/10 text-slate-400 hover:border-white/20'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-3 text-sm items-end">
          <select
            value={planningStatus}
            onChange={(e) => setPlanningStatus(e.target.value)}
            className={`rounded border border-white/15 bg-black px-2 py-1.5 text-slate-200 text-xs ${mono}`}
          >
            <option value="">All planning statuses</option>
            {PLANNING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <div className="min-w-[240px]">
            <MasterSearchSelect
              label="Customer"
              query={customerSearch.query}
              onQueryChange={(value) => {
                customerSearch.setQuery(value)
                setCustomerId('')
              }}
              loading={customerSearch.loading}
              options={customerSearch.options}
              lastUsed={customerSearch.lastUsed}
              onSelect={applyCustomer}
              getOptionLabel={(c) => c.name}
              getOptionMeta={(c) => c.contactName ?? ''}
              placeholder="Filter customer…"
              recentLabel="Recent customers"
              loadingMessage="Searching…"
              emptyMessage="No customer found."
            />
            {customerId ? (
              <button
                type="button"
                onClick={() => applyCustomer(null)}
                className="mt-1 text-[10px] text-slate-500 hover:text-slate-300"
              >
                Clear customer
              </button>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#000000] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
            Intelligent bottleneck strip
          </p>
          <div className="flex flex-wrap items-stretch gap-4 lg:gap-6">
            <div className="flex items-center gap-3 min-w-[10rem]">
              <ReadinessGauge pct={assetReadinessRatio} />
              <div>
                <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>
                  Readiness ratio
                </p>
                <p className={`text-sm font-medium text-slate-200 ${mono}`}>
                  {assetReadinessRatio}% job-card eligible
                </p>
                <p className="text-[10px] text-slate-600 mt-0.5 max-w-[14rem]">
                  5/5 interlock + plates + machine
                </p>
              </div>
            </div>

            <div className="hidden sm:block w-px bg-white/10 self-stretch min-h-[4rem]" aria-hidden />

            <div className="min-w-[12rem] flex-1">
              <p className={`text-[10px] uppercase tracking-wide text-slate-500 ${mono}`}>
                Primary blocker
              </p>
              <p className={`mt-1 text-sm text-rose-200/95 ${mono}`}>
                {primaryBottleneckInsight.label
                  ? `${primaryBottleneckInsight.pct}% · ${primaryBottleneckInsight.label}`
                  : '—'}
              </p>
              <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                {primaryBottleneckInsight.line}
              </p>
            </div>

            <div className="hidden sm:block w-px bg-white/10 self-stretch min-h-[4rem]" aria-hidden />

            <div className="min-w-[14rem] flex-[1.25]">
              <p className={`text-[10px] uppercase tracking-wide text-slate-500 mb-1.5 ${mono}`}>
                Machine load · 7d
              </p>
              <div className="flex flex-wrap gap-2">
                {machines.slice(0, 8).map((m) => {
                  const pct = machineLoadPct[m.id] ?? 0
                  return (
                    <div
                      key={m.id}
                      className="min-w-[6.5rem] flex-1 rounded border border-white/10 px-2 py-1 bg-zinc-950/60"
                      title={`Scheduled: ${(scheduledHoursByMachine[m.id] ?? 0).toFixed(1)} h / 168 h`}
                    >
                      <div className={`text-[9px] text-amber-400/90 ${mono}`}>{m.machineCode}</div>
                      <div className="mt-0.5 h-1 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            pct >= 85 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                      <div className={`text-[8px] text-slate-500 mt-0.5 ${mono}`}>{pct}%</div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setBottleneckBreakdownOpen((o) => !o)}
            className={`mt-3 text-[10px] text-amber-500/80 hover:text-amber-400 ${mono}`}
          >
            {bottleneckBreakdownOpen ? '▼ Hide' : '▶ Show'} bottleneck breakdown
          </button>

          {bottleneckBreakdownOpen ? (
            <div className="mt-2 rounded border border-white/10 bg-zinc-950/40 p-3">
              {pieData.length === 0 ? (
                <p className={`text-[11px] text-slate-600 ${mono}`}>No blockers — queue clear.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-4">
                  <div className="h-36 w-36 shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={26}
                          outerRadius={52}
                          paddingAngle={2}
                          onClick={(_, idx) => {
                            const d = pieData[idx]
                            if (d?.key) setSelectedBlocker((prev) => (prev === d.key ? null : d.key))
                          }}
                        >
                          {pieData.map((_, i) => (
                            <Cell
                              key={i}
                              fill={
                                ['#f59e0b', '#ef4444', '#a855f7', '#3b82f6', '#10b981', '#64748b'][i % 6]
                              }
                              stroke="#0a0a0a"
                              className="cursor-pointer"
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: '#0a0a0a',
                            border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: 8,
                            fontSize: 11,
                          }}
                          labelStyle={{ color: '#94a3b8' }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="min-w-0 flex-1 space-y-1 text-[11px]">
                    {blockerData.map((b) => (
                      <li key={b.key}>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedBlocker((k) => (k === b.key ? null : (b.key as BlockerCategory)))
                          }
                          className={`w-full text-left rounded border px-2 py-1 transition-colors ${
                            selectedBlocker === b.key
                              ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
                              : 'border-white/10 text-slate-400 hover:border-white/20'
                          }`}
                        >
                          <span className="font-medium text-slate-200">{b.label}</span>
                          <span className={`text-slate-500 ${mono}`}> · {b.count} jobs</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selectedBlocker ? (
                <div className="mt-2 max-h-28 overflow-y-auto rounded border border-white/10 bg-black/60 p-2">
                  <p className="text-[10px] text-slate-500 mb-1">Affected lines</p>
                  <ul className="space-y-0.5">
                    {(blockerData.find((x) => x.key === selectedBlocker)?.lineIds ?? []).map((id) => {
                      const line = rows.find((r) => r.id === id)
                      if (!line) return null
                      return (
                        <li key={id} className={`text-[10px] ${mono}`}>
                          <Link
                            href={`/orders/purchase-orders/${line.po.id}`}
                            className="text-amber-400 hover:underline"
                          >
                            {line.po.poNumber}
                          </Link>
                          <span className="text-slate-500"> · {line.cartonName.slice(0, 42)}</span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#000000] p-3">
          <ProductionScheduleBoard
            machines={machines}
            lines={scheduleBoardLines}
            readyPredicate={scheduleReady}
            syncSignature={scheduleSyncSignature}
            onPersistSchedule={persistSchedule}
            onPersistHandshake={persistHandshake}
          />
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#000000]">
          <div className="border-b border-slate-800 px-2 py-1.5">
            <p className={`text-[10px] font-semibold uppercase tracking-wide text-slate-500 ${mono}`}>
              Readiness ledger
            </p>
            <p className="text-[9px] text-slate-600">Mandatory 5-point interlock · AW · PA · DI · EB · SC</p>
          </div>
          <table className="w-full min-w-[1100px] border-collapse text-left text-[11px]">
            <thead className="border-b border-slate-800 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <tr className={`${mono}`}>
                <th className="w-6 px-0 py-1.5 text-center">Sel</th>
                <th className="w-7 px-1 py-1.5">Pri</th>
                <th className="w-[6.5rem] px-1 py-1.5">PO #</th>
                <th className="min-w-[7.5rem] px-1 py-1.5">Client</th>
                <th className="min-w-[9rem] px-1 py-1.5">Product</th>
                <th className="w-[4.5rem] px-1 py-1.5">UPS</th>
                <th className="min-w-[7rem] px-1 py-1.5">Designer</th>
                <th className="w-[9rem] px-1 py-1.5">Readiness</th>
                <th className="min-w-[12rem] px-1 py-1.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {groupSortedPlanningRows.map((r) => {
                const spec = r.specOverrides || {}
                const ledger = r.planningLedger
                const mat = ledger?.materialGate
                const machine = spec.machineId ? machines.find((m) => m.id === spec.machineId) : null
                const smartBest = pickBestMachineId(
                  machines.map((m) => ({
                    id: m.id,
                    machineCode: m.machineCode,
                    specification: m.specification ?? null,
                    capacityPerShift: m.capacityPerShift ?? 4000,
                  })),
                  {
                    colours: r.planningLedger?.numberOfColours ?? null,
                    sheetLengthMm: Number(r.carton?.blankLength ?? r.dimLengthMm ?? 0) || null,
                    sheetWidthMm: Number(r.carton?.blankWidth ?? r.dimWidthMm ?? 0) || null,
                    scheduledHoursByMachineId: scheduledHoursByMachine,
                  },
                )
                const unassigned = !String(spec.machineId ?? '').trim()
                const highlightSmartOption = unassigned && smartBest
                const pri = lineIndustrialPriority(r)
                const expanded = expandedId === r.id
                const genOk = canGenerateJobCard(r)
                const five = readinessFiveForLine(r)
                const platesSt = String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required')
                const blockerName = firstFivePointBlockerName(five.segments, platesSt)
                const canAssignMachine = five.allGreen
                const assignBlockReason =
                  firstFivePointBlockerName(five.segments, platesSt) ?? 'Complete 5-point readiness interlock'
                const planCore = readPlanningCore(spec as Record<string, unknown>)

                return (
                  <Fragment key={r.id}>
                    <tr
                      className={`transition-colors hover:bg-white/[0.03] ${
                        pri ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''
                      } ${r.directorHold ? 'opacity-45' : ''}`}
                    >
                      <td className="px-0 py-1 align-middle text-center">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-amber-500"
                          checked={planningSelection.has(r.id)}
                          onChange={() => {
                            setPlanningSelection((prev) => {
                              const next = new Set(prev)
                              if (next.has(r.id)) next.delete(r.id)
                              else next.add(r.id)
                              return next
                            })
                          }}
                          aria-label="Select for mix-set"
                        />
                      </td>
                      <td className="px-1 py-1 align-middle">
                        {pri ? (
                          <Star
                            className={`h-3.5 w-3.5 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`}
                            aria-label="Industrial priority"
                          />
                        ) : (
                          <span className="inline-block w-3.5" />
                        )}
                      </td>
                      <td
                        className={`px-1 py-1 align-middle ${mono} ${
                          pri ? 'text-amber-300' : 'text-amber-200/90'
                        }`}
                      >
                        <Link
                          href={`/orders/purchase-orders/${r.po.id}`}
                          className={`hover:underline block text-[10px] leading-tight ${pri ? 'text-amber-300' : ''}`}
                        >
                          {r.po.poNumber}
                        </Link>
                        <div className={`text-[10px] tabular-nums ${pri ? 'text-amber-200/95' : 'text-slate-400'}`}>
                          {r.quantity.toLocaleString('en-IN')}
                        </div>
                      </td>
                      <td className="px-1 py-1 align-middle leading-tight">
                        <div className="text-slate-400 truncate max-w-[11rem] text-[10px]">{r.po.customer.name}</div>
                      </td>
                      <td className="px-1 py-1 align-middle leading-tight">
                        {r.cartonId ? (
                          <Link
                            href={`/product/${r.cartonId}`}
                            className={`text-slate-100 hover:text-amber-300 truncate block max-w-[14rem] text-[10px] ${mono}`}
                          >
                            {r.cartonName}
                          </Link>
                        ) : (
                          <span className={`text-slate-200 truncate block max-w-[14rem] text-[10px] ${mono}`}>
                            {r.cartonName}
                          </span>
                        )}
                      </td>
                      <td className="px-1 py-1 align-middle">
                        <input
                          type="number"
                          min={1}
                          className={`w-full max-w-[4rem] h-7 rounded border border-white/15 bg-black px-1 text-[10px] text-slate-200 ${mono}`}
                          value={planCore.ups ?? r.materialQueue?.ups ?? ''}
                          placeholder="UPS"
                          onChange={(e) => {
                            const ups = Math.max(1, parseInt(e.target.value, 10) || 1)
                            const prev = readPlanningCore(spec as Record<string, unknown>)
                            const sl = Number(r.materialQueue?.sheetLengthMm ?? 0)
                            const sw = Number(r.materialQueue?.sheetWidthMm ?? 0)
                            const bl = Number(r.carton?.blankLength ?? r.dimLengthMm ?? 0)
                            const bw = Number(r.carton?.blankWidth ?? r.dimWidthMm ?? 0)
                            const sheetL = sl > 0 ? sl : 1020
                            const sheetW = sw > 0 ? sw : 720
                            const { yieldPct } =
                              bl > 0 && bw > 0
                                ? computeSheetUtilization({
                                    blankLengthMm: bl,
                                    blankWidthMm: bw,
                                    sheetLengthMm: sheetL,
                                    sheetWidthMm: sheetW,
                                    ups,
                                  })
                                : { yieldPct: 0 }
                            updateSpec(r.id, {
                              planningCore: {
                                ...prev,
                                ups,
                                actualSheetSizeLabel:
                                  sl > 0 && sw > 0 ? formatSheetSizeMm(sl, sw) : undefined,
                                productionYieldPct: yieldPct,
                              },
                            })
                          }}
                        />
                        <div className={`text-[8px] text-slate-600 mt-0.5 ${mono}`}>
                          Y:{planCore.productionYieldPct != null ? `${planCore.productionYieldPct}%` : '—'}
                        </div>
                      </td>
                      <td className="px-1 py-1 align-middle">
                        <select
                          value={planCore.designerKey ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            const prev = readPlanningCore(spec as Record<string, unknown>)
                            updateSpec(r.id, {
                              planningCore: {
                                ...prev,
                                designerKey:
                                  v === 'avneet_singh' || v === 'shamsher_inder'
                                    ? v
                                    : undefined,
                              },
                            })
                          }}
                          className={`w-full max-w-[9rem] h-7 rounded border border-white/15 bg-black px-1 text-[9px] text-slate-200 ${mono}`}
                        >
                          <option value="">— Designer —</option>
                          <option value="avneet_singh">Avneet Singh</option>
                          <option value="shamsher_inder">Shamsher Inder</option>
                        </select>
                        {planCore.layoutType === 'gang' ? (
                          <span className="mt-0.5 inline-block rounded border border-sky-500/40 bg-sky-500/10 px-1 text-[8px] text-sky-300">
                            Gang
                          </span>
                        ) : null}
                      </td>
                      <td className="px-1 py-1 align-middle">
                        <div className="flex flex-wrap items-center gap-1">
                          <ReadinessFiveBar segments={five.segments} />
                          <button
                            type="button"
                            onClick={() => setPlanningDrawerLineId(r.id)}
                            className={`shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[8px] font-semibold uppercase text-amber-200 hover:bg-amber-500/20 ${mono}`}
                          >
                            Radar
                          </button>
                        </div>
                      </td>
                      <td className="px-1 py-1 align-middle text-right">
                        <div className="inline-flex flex-col items-end gap-1 max-w-[14rem] ml-auto">
                          <div className="w-full text-left">
                            <span className={`text-[8px] uppercase tracking-wide text-slate-500 ${mono}`}>
                              Assign to machine
                            </span>
                            <select
                              value={spec.machineId ?? ''}
                              disabled={!canAssignMachine || !!r.directorHold}
                              title={
                                canAssignMachine && !r.directorHold
                                  ? 'Select press'
                                  : r.directorHold
                                    ? 'Director hold'
                                    : assignBlockReason
                              }
                              onChange={(e) =>
                                updateSpec(r.id, {
                                  machineId: e.target.value || undefined,
                                })
                              }
                              className={`mt-0.5 max-w-[11rem] h-7 w-full rounded border border-white/15 bg-black px-1 text-[10px] text-slate-200 disabled:cursor-not-allowed disabled:opacity-40 ${mono}`}
                            >
                              <option value="">Unassigned</option>
                              {machines.map((m) => (
                                <option
                                  key={m.id}
                                  value={m.id}
                                  className={
                                    highlightSmartOption && smartBest && m.id === smartBest.id
                                      ? 'bg-emerald-500/10 font-medium'
                                      : undefined
                                  }
                                >
                                  {m.machineCode}
                                  {highlightSmartOption && smartBest && m.id === smartBest.id
                                    ? ' · Smart match'
                                    : ''}
                                </option>
                              ))}
                            </select>
                            {highlightSmartOption && smartBest && canAssignMachine ? (
                              <button
                                type="button"
                                title="Apply smart match (colours + sheet size + load)"
                                onClick={() => updateSpec(r.id, { machineId: smartBest.id })}
                                className={`mt-0.5 block text-left text-[9px] text-emerald-400/90 hover:text-emerald-300 ${mono}`}
                              >
                                Apply {smartBest.machineCode}
                              </button>
                            ) : null}
                            {canAssignMachine ? (
                              <button
                                type="button"
                                title="Re-score all presses (colours, bed, load)"
                                onClick={() => applySmartMachine(r)}
                                className={`mt-0.5 block text-left text-[9px] text-sky-400/90 hover:text-sky-300 ${mono}`}
                              >
                                Smart balance
                              </button>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => void save(r.id)}
                              disabled={savingId === r.id}
                              className="rounded border border-amber-700/50 px-2 py-0.5 text-[10px] text-amber-200/90 hover:bg-amber-500/10 disabled:opacity-40"
                            >
                              {savingId === r.id ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setExpandedId(expanded ? null : r.id)}
                              className={`inline-flex items-center rounded border border-white/15 p-0.5 text-slate-400 hover:border-amber-500/40 ${mono}`}
                              title={expanded ? 'Collapse spec' : 'Expand spec'}
                              aria-expanded={expanded}
                            >
                              {expanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </button>
                            {r.jobCard?.id ? (
                              <Link
                                href={`/production/job-cards/${r.jobCard.id}`}
                                className={`text-[10px] text-sky-400 hover:underline ${mono}`}
                              >
                                JC#{r.jobCard.jobCardNumber}
                              </Link>
                            ) : null}
                            <button
                              type="button"
                              disabled={!genOk || generatingId === r.id}
                              onClick={() => void generateJobCard(r)}
                              className={`rounded border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                                genOk
                                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                                  : 'border-white/15 border-dashed bg-transparent text-slate-500 cursor-not-allowed opacity-45 shadow-none'
                              } disabled:opacity-35`}
                              title={
                                genOk
                                  ? 'Generate job card — locks die / emboss / shade to this JC in hubs'
                                  : blockerName
                                    ? `Blocked: Missing ${blockerName}`
                                    : !String(spec.machineId ?? '').trim()
                                      ? 'Blocked: Missing Machine'
                                      : 'Complete planning interlock'
                              }
                            >
                              {generatingId === r.id ? '…' : 'Generate Job Card'}
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr key={`${r.id}-spec`} className="bg-black/80">
                        <td colSpan={9} className="px-3 py-2 border-t border-slate-800">
                          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-[11px]">
                            <label className="space-y-0.5">
                              <span className="text-slate-500">Set #</span>
                              <input
                                type="text"
                                value={r.setNumber ?? ''}
                                onChange={(e) =>
                                  updateRow(r.id, { setNumber: e.target.value || null })
                                }
                                className={`w-full h-8 rounded border border-white/15 bg-black px-2 text-slate-200 ${mono}`}
                              />
                            </label>
                            <label className="space-y-0.5">
                              <span className="text-slate-500">Planning status</span>
                              <select
                                value={r.planningStatus}
                                onChange={(e) =>
                                  updateRow(r.id, { planningStatus: e.target.value })
                                }
                                className={`w-full h-8 rounded border border-white/15 bg-black px-2 text-slate-200 ${mono}`}
                              >
                                {PLANNING_STATUSES.map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="space-y-0.5">
                              <span className="text-slate-500">Planned date</span>
                              <input
                                type="date"
                                value={spec.plannedDate ?? ''}
                                onChange={(e) =>
                                  updateSpec(r.id, {
                                    plannedDate: e.target.value || undefined,
                                  })
                                }
                                className={`w-full h-8 rounded border border-white/15 bg-black px-2 text-slate-200 tabular-nums [color-scheme:dark] ${mono}`}
                              />
                            </label>
                            <label className="space-y-0.5">
                              <span className="text-slate-500">Est. run</span>
                              <div
                                className={`flex h-8 items-center rounded border border-white/10 bg-zinc-950/60 px-2 text-slate-300 ${mono}`}
                              >
                                {ledger?.estimatedDurationHours != null
                                  ? formatDurationHMM(ledger.estimatedDurationHours)
                                  : '—'}
                              </div>
                            </label>
                            <label className="space-y-0.5">
                              <span className="text-slate-500">Plates</span>
                              <select
                                value={String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required')}
                                onChange={(e) =>
                                  updateSpec(r.id, {
                                    platesStatus: e.target.value as PlanningSpec['platesStatus'],
                                  })
                                }
                                className={`w-full h-8 rounded border border-white/15 bg-black px-2 text-slate-200 ${mono}`}
                              >
                                <option value="available">Ready</option>
                                <option value="partial">Partial</option>
                                <option value="new_required">Not ready</option>
                              </select>
                            </label>
                            <label className="space-y-0.5">
                              <span className="text-slate-500">Die</span>
                              <select
                                value={String(spec.dieStatus ?? r.readiness?.dieStatus ?? (r.dyeId ? 'good' : 'not_available'))}
                                onChange={(e) =>
                                  updateSpec(r.id, {
                                    dieStatus: e.target.value as PlanningSpec['dieStatus'],
                                  })
                                }
                                className={`w-full h-8 rounded border border-white/15 bg-black px-2 text-slate-200 ${mono}`}
                              >
                                <option value="good">Ready</option>
                                <option value="attention">Attention</option>
                                <option value="not_available">Not ready</option>
                              </select>
                            </label>
                            <label className="space-y-0.5">
                              <span className="text-slate-500">Emboss block</span>
                              <select
                                value={String(spec.embossStatus ?? 'vendor_ordered')}
                                disabled={!isEmbossingRequired(r.embossingLeafing)}
                                onChange={(e) =>
                                  updateSpec(r.id, {
                                    embossStatus: e.target.value as PlanningSpec['embossStatus'],
                                  })
                                }
                                className={`w-full h-8 rounded border border-white/15 bg-black px-2 text-slate-200 ${mono} disabled:opacity-50`}
                              >
                                <option value="na">N/A</option>
                                <option value="ready">Ready</option>
                                <option value="vendor_ordered">Not ready</option>
                              </select>
                            </label>
                            <label className="space-y-0.5">
                              <span className="text-slate-500">Shift</span>
                              <select
                                value={spec.shift ?? ''}
                                onChange={(e) =>
                                  updateSpec(r.id, { shift: e.target.value || undefined })
                                }
                                className={`w-full h-8 rounded border border-white/15 bg-black px-2 text-slate-200 ${mono}`}
                              >
                                <option value="">—</option>
                                {SHIFTS.map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {mat ? (
                              <div
                                className={`sm:col-span-2 lg:col-span-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2 ${mono} text-[10px]`}
                              >
                                <span className="text-slate-500 font-semibold uppercase tracking-wide">
                                  PA · Board
                                </span>
                                <span
                                  className={`inline-flex rounded px-1.5 py-0.5 font-bold ${materialBadgeClass(mat)}`}
                                >
                                  {materialBadgeLabel(mat)}
                                </span>
                                {mat.requiredSheets != null ? (
                                  <span className="text-slate-400">
                                    Req {mat.requiredSheets.toLocaleString('en-IN')}
                                    {mat.netAvailable != null
                                      ? ` · Net ${mat.netAvailable.toLocaleString('en-IN')}`
                                      : ''}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            {machine ? (
                              <p className={`text-slate-500 ${mono} text-[10px] sm:col-span-2`}>
                                Press {machine.machineCode} · std waste{' '}
                                {machine.stdWastePct != null ? Number(machine.stdWastePct) : 0}% · cap/shift{' '}
                                {machine.capacityPerShift?.toLocaleString?.('en-IN') ?? '—'}
                              </p>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
              {tabFilteredRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-500 text-sm">
                    No items in planning queue.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <footer className={`border-t border-slate-800 pt-3 text-center text-[10px] text-slate-500 ${mono}`}>
          Planning Decision Active - Zero-Error Handshake to AW Queue Enabled.
          {integrityFooter ? <span className="block mt-1 text-slate-600">{integrityFooter}</span> : null}
        </footer>

        <PlanningReadinessDrawer
          open={planningDrawerLineId != null}
          line={planningDrawerLine}
          onClose={() => setPlanningDrawerLineId(null)}
        />
      </div>
    </div>
  )
}
