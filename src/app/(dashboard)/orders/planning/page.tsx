'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { mergeOrchestrationIntoSpec, PLANNING_FLOW } from '@/lib/orchestration-spec'
import {
  computeSheetUtilization,
  formatSheetSizeMm,
  generateMasterSetId,
  PLANNING_DESIGNERS,
  readPlanningCore,
  readPlanningMeta,
  suggestNextAutoSetNumber,
  type PlanningCore,
  type PlanningDesignerKey,
  type PlanningSetIdMode,
} from '@/lib/planning-decision-spec'
import {
  PlanningDecisionGrid,
  type PlanningGridLine,
  type PlanningLineFieldPatch,
} from '@/components/planning/PlanningDecisionGrid'
import { PlanningBatchBuilderPanel } from '@/components/planning/PlanningBatchBuilderPanel'
import { ActionBar, PageHeader } from '@/components/design-system'
import { Button } from '@/components/design-system/Button'
import { PlanningJobDetailDrawer } from '@/components/planning/PlanningJobDetailDrawer'
import { PlanningSuggestedBatchesPanel } from '@/components/planning/PlanningSuggestedBatchesPanel'
import { PlanningPoSummaryDrawer } from '@/components/planning/PlanningPoSummaryDrawer'
import { PlanningProductDetailDrawer } from '@/components/planning/PlanningProductDetailDrawer'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { PlanningSummaryPanel } from '@/components/planning/PlanningSummaryPanel'
import {
  PlanningDecisionLayerToolbar,
  type PlanningGroupBy,
} from '@/components/planning/PlanningDecisionLayerToolbar'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'
import {
  aggregatePlanningBlockers,
} from '@/lib/planning-analytics'
import {
  computeFivePointReadiness,
  firstFivePointBlockerName,
  type ReadinessFiveSegment,
} from '@/lib/planning-interlock'
import { type ScheduleHandshake } from '@/lib/production-schedule-spec'
import {
  applyBatchDecisionAction,
  isBatchExcludedFromForwardSteps,
  projectPlanningBatchFields,
  type PlanningBatchDecisionAction,
} from '@/lib/planning-batch-decision'
import type { SuggestableLine } from '@/lib/planning-batch-suggestions'
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
  /** Per-line planner notes; `ups` = repeats of this product in one gang layout (not `planningCore.ups`). */
  meta?: { ups?: number; designer?: string } & Record<string, unknown>
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
  otherCoating: string | null
  embossingLeafing: string | null
  paperType: string | null
  artworkCode: string | null
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
    artworkCode?: string | null
    laminateType?: string | null
    coatingType?: string | null
    paperType?: string | null
    gsm?: number | null
    numberOfColours?: number | null
  } | null
  dieMaster?: { id: string; dyeNumber: number; ups: number; sheetSize: string } | null
  createdAt?: string
}

type Customer = { id: string; name: string; contactName?: string | null }

const mono = 'font-designing-queue tabular-nums tracking-tight'

function lineToSuggestable(r: Line): SuggestableLine {
  return {
    id: r.id,
    cartonName: r.cartonName,
    quantity: r.quantity,
    coatingType: r.coatingType,
    otherCoating: r.otherCoating,
    paperType: r.paperType,
    gsm: r.gsm,
    planningStatus: r.planningStatus,
    specOverrides: (r.specOverrides as Record<string, unknown> | null) ?? null,
    materialQueue: r.materialQueue ?? null,
    carton: r.carton
      ? {
          blankLength: r.carton.blankLength,
          blankWidth: r.carton.blankWidth,
          gsm: r.carton.gsm,
          coatingType: r.carton.coatingType,
          laminateType: r.carton.laminateType,
          paperType: r.carton.paperType,
          numberOfColours: r.carton.numberOfColours ?? undefined,
        }
      : null,
    dimLengthMm: r.dimLengthMm,
    dimWidthMm: r.dimWidthMm,
    po: {
      poNumber: r.po.poNumber,
      poDate: r.po.poDate,
      isPriority: r.po.isPriority,
      status: r.po.status,
    },
    directorHold: r.directorHold,
    planningLedger: r.planningLedger
      ? {
          toolingInterlock: {
            allReady: r.planningLedger.toolingInterlock?.allReady ?? false,
          },
        }
      : null,
  }
}

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

export default function PlanningPage() {
  const [rows, setRows] = useState<Line[]>([])
  const [loading, setLoading] = useState(true)
  const [customerId, setCustomerId] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [ledgerView, setLedgerView] = useState<'pending' | 'processed'>('pending')
  const [makeProcessingBusy, setMakeProcessingBusy] = useState(false)
  const [planningSelection, setPlanningSelection] = useState<Set<string>>(new Set())
  const [batchBuilderOpen, setBatchBuilderOpen] = useState(false)
  const [planningGroupBy, setPlanningGroupBy] = useState<PlanningGroupBy>('none')
  const [planningSetIdMode, setPlanningSetIdMode] = useState<PlanningSetIdMode>('auto')
  const [planningDrawerLineId, setPlanningDrawerLineId] = useState<string | null>(null)
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null)
  const [poSummaryDrawerId, setPoSummaryDrawerId] = useState<string | null>(null)
  const [productDrawerLine, setProductDrawerLine] = useState<PlanningGridLine | null>(null)
  const [savingPlanningHandoff, setSavingPlanningHandoff] = useState(false)
  const [batchActionBusy, setBatchActionBusy] = useState(false)
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (typeof window === 'undefined') return
    const q = new URLSearchParams(window.location.search)
    if (q.get('view') === 'pending') setLedgerView('pending')
  }, [])

  /** Batch builder (2+ checkboxes) supersedes row detail — one primary slide-over at a time. */
  useEffect(() => {
    if (planningSelection.size >= 2) setPlanningDrawerLineId(null)
  }, [planningSelection.size])

  useEffect(() => {
    if (planningSelection.size < 2) setBatchBuilderOpen(false)
  }, [planningSelection.size])

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

  const fetchRows = useCallback(async (opts?: { force?: boolean }) => {
    const params = new URLSearchParams()
    if (customerId) params.set('customerId', customerId)
    if (opts?.force) params.set('_', String(Date.now()))
    const res = await fetch(`/api/planning/po-lines?${params}`, { cache: 'no-store' })
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
  }, [customerId])

  useEffect(() => {
    async function load() {
      try {
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

  useEffect(() => {
    const onPlanningRefresh = () => {
      void fetchRowsRef.current({ force: true })
    }
    window.addEventListener('planning:refresh', onPlanningRefresh)
    return () => window.removeEventListener('planning:refresh', onPlanningRefresh)
  }, [])

  const blockerData = useMemo(() => aggregatePlanningBlockers(rows), [rows])

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

  const incomingFromPo = useMemo(
    () =>
      rows.filter((r) => {
        const spec = (r.specOverrides || {}) as Record<string, unknown>
        if (!spec.releasedToPlanningAt) return false
        if (r.planningStatus !== 'pending') return false
        if (String(r.po.status).toLowerCase() !== 'sent_to_planning') return false
        if (spec.planningIncomingDecision) return false
        return true
      }),
    [rows],
  )

  const [incomingBusy, setIncomingBusy] = useState<string | null>(null)

  const applyIncomingDecision = useCallback(
    async (lineId: string, action: 'approve' | 'hold' | 'artwork') => {
      const li = rows.find((r) => r.id === lineId)
      if (!li) return
      setIncomingBusy(lineId)
      try {
        const spec = {
          ...(li.specOverrides && typeof li.specOverrides === 'object' ? li.specOverrides : {}),
        } as Record<string, unknown>
        const now = new Date().toISOString()
        spec.planningIncomingDecision =
          action === 'approve' ? 'approved_production' : action === 'hold' ? 'on_hold' : 'send_artwork'
        spec.planningIncomingDecidedAt = now
        if (action === 'artwork') spec.planningHandoffTarget = 'artwork'
        const body: Record<string, unknown> = {
          specOverrides: spec,
          planningDecisionRevision: true,
        }
        if (action === 'hold') body.directorHold = true
        if (action === 'approve' || action === 'artwork') body.directorHold = false
        const res = await fetch(`/api/planning/po-lines/${lineId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) throw new Error(j.error || 'Update failed')
        if (action === 'approve') toast.success('Approved — line stays in your queue for full planning work')
        else if (action === 'hold') toast.success('Line placed on hold')
        else {
          toast.success('Marked for Artwork — Designing queue opened in a new tab')
          window.open('/orders/designing', '_blank', 'noopener,noreferrer')
        }
        await fetchRows()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed')
      } finally {
        setIncomingBusy(null)
      }
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

  const linkLineIdsAsMixSet = useCallback(
    (ids: string[]) => {
      if (ids.length < 2) {
        toast.error('Select at least two lines for a mix-set')
        return
      }
      const master = generateMasterSetId()
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
            batchStatus: 'draft',
            batchHoldReason: null,
            batchStatusBeforeHold: null,
          },
        })
      }
      setPlanningSelection(new Set(ids))
      toast.success('Mix-set linked — one Master Set ID; complete UPS & designer, then Save planning')
    },
    [rows, updateSpec],
  )

  const linkAsMixSet = useCallback(() => {
    if (planningSelection.size < 2) return
    linkLineIdsAsMixSet(Array.from(planningSelection))
  }, [planningSelection, linkLineIdsAsMixSet])

  const suggestableLines = useMemo((): SuggestableLine[] => {
    const view = rows.filter((r) => {
      const pending = r.planningStatus === 'pending'
      return ledgerView === 'pending' ? pending : !pending
    })
    const bumpAt = (r: Line) =>
      String(
        r.specOverrides && typeof r.specOverrides === 'object'
          ? (r.specOverrides as Record<string, unknown>).planningQueueBumpAt ?? ''
          : '',
      )
    const ordered =
      ledgerView === 'pending'
        ? [...view]
            .map((r, idx) => ({ r, idx }))
            .sort((a, b) => {
              const c = bumpAt(b.r).localeCompare(bumpAt(a.r))
              if (c !== 0) return c
              return a.idx - b.idx
            })
            .map(({ r }) => r)
        : view
    return ordered.map(lineToSuggestable)
  }, [rows, ledgerView])

  const applyBatchDecision = useCallback(
    async (
      lineIds: string[],
      action: PlanningBatchDecisionAction,
      holdReason?: string,
      opts?: { suppressToast?: boolean },
    ): Promise<boolean> => {
      if (lineIds.length === 0) return false
      setBatchActionBusy(true)
      try {
        const first = rows.find((r) => r.id === lineIds[0])
        if (!first) {
          toast.error('Line not found')
          return false
        }
        const base = readPlanningCore(first.specOverrides as Record<string, unknown>)
        const result = applyBatchDecisionAction(base, action, { holdReason })
        if (!result) {
          toast.error('This action is not available for the current group status')
          return false
        }
        const batchSlice = projectPlanningBatchFields(result)
        for (const id of lineIds) {
          const li = rows.find((r) => r.id === id)
          if (!li) continue
          const spec = (li.specOverrides && typeof li.specOverrides === 'object' ? li.specOverrides : {}) as Record<
            string,
            unknown
          >
          const p = readPlanningCore(spec)
          const planningCore = { ...p, ...batchSlice }
          const now = new Date().toISOString()
          const handoffSpec =
            action === 'send_to_artwork'
              ? mergeOrchestrationIntoSpec(
                  {
                    ...spec,
                    planningMakeProcessingAt: now,
                    planningMakeProcessingBy: 'planner',
                  },
                  {
                    planningFlowStatus: PLANNING_FLOW.in_progress,
                    awQueueHandoffAt: now,
                  },
                )
              : spec
          const res = await fetch(`/api/planning/po-lines/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              planningStatus: action === 'send_to_artwork' ? 'planned' : li.planningStatus,
              specOverrides: { ...handoffSpec, planningCore },
              planningDecisionRevision: true,
            }),
          })
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string }
            throw new Error(j.error || 'Update failed')
          }
        }
        if (action === 'send_to_artwork' && !opts?.suppressToast) {
          const fs = ((first.specOverrides && typeof first.specOverrides === 'object'
            ? first.specOverrides
            : {}) as Record<string, unknown>)
          const fm = readPlanningMeta(fs)
          const designer =
            typeof fs.planningDesignerDisplayName === 'string' && fs.planningDesignerDisplayName.trim()
              ? fs.planningDesignerDisplayName.trim()
              : (() => {
                  const k = readPlanningCore(fs).designerKey
                  return k ? PLANNING_DESIGNERS[k] : ''
                })()
          const ups = typeof fm.ups === 'number' && Number.isFinite(fm.ups) && fm.ups >= 1 ? Math.floor(fm.ups) : null
          toast.success(
            designer || ups != null ? `Assigned to ${designer || 'designer'}${ups != null ? ` • Ups: ${ups}` : ''}` : 'Group updated',
          )
        } else if (!opts?.suppressToast) {
          toast.success('Group updated')
        }
        await fetchRows()
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Update failed')
        return false
      } finally {
        setBatchActionBusy(false)
      }
    },
    [rows, fetchRows],
  )

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
    const held = candidates.filter((r) =>
      isBatchExcludedFromForwardSteps(readPlanningCore(r.specOverrides as Record<string, unknown>)),
    )
    if (held.length > 0) {
      toast.error('A group is on hold — resume the group or exclude those lines before saving handoff')
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
          toast.error('Manual Set ID: enter Set # for each line (PO or planning save) before handoff')
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

  const savePlanningLine = useCallback(
    async (
      id: string,
      patch: PlanningLineFieldPatch = {},
      specSnapshot?: Record<string, unknown> | null,
    ): Promise<boolean> => {
      const li = rows.find((x) => x.id === id)
      if (!li) return false
      setSavingId(id)
      try {
        const raw =
          specSnapshot ??
          (patch.specOverrides !== undefined
            ? { ...patch.specOverrides }
            : li.specOverrides && typeof li.specOverrides === 'object'
              ? (li.specOverrides as Record<string, unknown>)
              : ({} as Record<string, unknown>))
        let specOverrides: Record<string, unknown> = { ...raw }
        if (String(specOverrides.machineId || '').trim()) {
          specOverrides = mergeOrchestrationIntoSpec(specOverrides, {
            planningFlowStatus: PLANNING_FLOW.in_progress,
          })
        }
        const body: Record<string, unknown> = {
          setNumber: li.setNumber,
          planningStatus: li.planningStatus,
          remarks: patch.remarks !== undefined ? patch.remarks : li.remarks,
          specOverrides,
          planningDecisionRevision: true,
        }
        if (patch.cartonName !== undefined) body.cartonName = patch.cartonName
        if (patch.cartonSize !== undefined) body.cartonSize = patch.cartonSize
        if (patch.quantity !== undefined) body.quantity = patch.quantity
        if (patch.rate !== undefined) body.rate = patch.rate
        if (patch.gsm !== undefined) body.gsm = patch.gsm
        if (patch.paperType !== undefined) body.paperType = patch.paperType
        if (patch.coatingType !== undefined) body.coatingType = patch.coatingType
        if (patch.otherCoating !== undefined) body.otherCoating = patch.otherCoating
        if (patch.embossingLeafing !== undefined) body.embossingLeafing = patch.embossingLeafing
        const res = await fetch(`/api/planning/po-lines/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!res.ok) {
          toast.error((json as { error?: string }).error || 'Save failed')
          return false
        }
        await fetchRows()
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save')
        return false
      } finally {
        setSavingId(null)
      }
    },
    [rows, fetchRows],
  )

  const save = async (id: string, opts?: { remarks?: string | null }) => {
    const patch: PlanningLineFieldPatch = {}
    if (opts && opts.remarks !== undefined) patch.remarks = opts.remarks
    const ok = await savePlanningLine(id, patch)
    if (ok) toast.success('Planning updated')
  }

  const totalQty = useMemo(
    () => rows.reduce((sum, r) => sum + (r.quantity || 0), 0),
    [rows],
  )

  const makeProcessingForIds = useCallback(
    async (ids: string[], opts?: { suppressToast?: boolean }): Promise<boolean> => {
      if (ids.length === 0) return false
      const blocked = ids.filter((id) => {
        const r = rows.find((x) => x.id === id)
        if (!r) return false
        return isBatchExcludedFromForwardSteps(readPlanningCore(r.specOverrides as Record<string, unknown>))
      })
      if (blocked.length > 0) {
        if (!opts?.suppressToast) toast.error('A selected line is in a group on hold — clear hold first')
        return false
      }
      setMakeProcessingBusy(true)
      try {
        const res = await fetch('/api/planning/po-lines/make-processing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lineIds: ids }),
        })
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) {
          if (!opts?.suppressToast) toast.error(j.error ?? 'Failed')
          return false
        }
        if (!opts?.suppressToast) toast.success(`Sent ${ids.length} line(s) to AW queue`)
        setPlanningSelection(new Set())
        await fetchRows()
        return true
      } finally {
        setMakeProcessingBusy(false)
      }
    },
    [rows, fetchRows],
  )

  const handleMakeProcessing = useCallback(async () => {
    const ids = Array.from(planningSelection)
    void makeProcessingForIds(ids)
  }, [planningSelection, makeProcessingForIds])

  const recallLine = useCallback(
    async (lineId: string) => {
      try {
        const res = await fetch(`/api/planning/po-lines/${lineId}/recall-from-aw`, {
          method: 'POST',
          cache: 'no-store',
        })
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) throw new Error(j.error || 'Recall failed')
        setPlanningDrawerLineId(null)
        setHighlightedRowId(lineId)
        window.setTimeout(() => setHighlightedRowId(null), 3000)
        await fetchRows({ force: true })
        toast.success('Returned to Planning', {
          action: {
            label: 'View Pending',
            onClick: () => setLedgerView('pending'),
          },
        })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Recall failed')
      }
    },
    [fetchRows, setLedgerView],
  )

  const planningDrawerLine = useMemo(
    () => (planningDrawerLineId ? rows.find((r) => r.id === planningDrawerLineId) ?? null : null),
    [rows, planningDrawerLineId],
  )

  const selectedGridLines = useMemo((): PlanningGridLine[] => {
    return Array.from(planningSelection)
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is Line => !!r) as PlanningGridLine[]
  }, [planningSelection, rows])

  if (loading) {
    return (
      <div className={`min-h-[30vh] p-4 text-ds-ink-muted ${mono}`}>Loading planning…</div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ds-main text-ds-ink">
      <div className="shrink-0 space-y-2 border-b border-ds-line/60 bg-ds-main px-3 py-2">
        <PageHeader
          className="!pb-2"
          title="Planning"
          description={
            <p className={`text-[13px] font-medium text-ds-ink-muted ${mono}`}>
              {rows.length} line(s) · Σ qty{' '}
              <span className="font-semibold text-ds-success tabular-nums">
                {totalQty.toLocaleString('en-IN')}
              </span>
            </p>
          }
          actions={
            <div className="flex w-full max-w-3xl flex-col gap-2 sm:ml-auto sm:items-end">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wider text-ds-ink-faint">View</span>
                  <div className="inline-flex rounded-ds-md border border-ds-line/80 bg-ds-elevated/50 p-0.5">
                    <button
                      type="button"
                      onClick={() => setLedgerView('pending')}
                      className={`rounded-ds-sm px-3 py-1.5 text-[13px] font-medium transition duration-200 ${
                        ledgerView === 'pending' ? 'bg-ds-brand text-white shadow-sm' : 'text-ds-ink-muted hover:text-ds-ink'
                      }`}
                    >
                      Pending
                    </button>
                    <button
                      type="button"
                      onClick={() => setLedgerView('processed')}
                      className={`rounded-ds-sm px-3 py-1.5 text-[13px] font-medium transition duration-200 ${
                        ledgerView === 'processed' ? 'bg-ds-brand text-white shadow-sm' : 'text-ds-ink-muted hover:text-ds-ink'
                      }`}
                    >
                      Processed
                    </button>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant={batchBuilderOpen ? 'secondary' : 'primary'}
                  onClick={() => setBatchBuilderOpen((o) => !o)}
                  disabled={planningSelection.size < 2}
                  className="px-3 py-2 text-[13px]"
                >
                  {batchBuilderOpen
                    ? `Close Group Builder (${planningSelection.size})`
                    : `Open Group Builder (${planningSelection.size})`}
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleMakeProcessing()}
                  disabled={planningSelection.size === 0 || makeProcessingBusy}
                  className="px-3 py-2 text-[13px]"
                >
                  {makeProcessingBusy ? 'Processing…' : 'Make processing'}
                </Button>
                <Link
                  href="/hub/dies"
                  className="inline-flex items-center justify-center gap-2 rounded-ds-sm border border-ds-line bg-ds-elevated/80 px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition duration-200 hover:bg-ds-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ds-brand/25"
                >
                  Dyes
                </Link>
                <Link
                  href="/orders/purchase-orders"
                  className="rounded-ds-sm border border-ds-line/80 bg-ds-elevated/60 px-2 py-1.5 text-xs text-ds-ink transition duration-200 hover:border-ds-line hover:bg-ds-elevated"
                >
                  POs
                </Link>
                <Link
                  href="/orders/designing"
                  className="rounded-ds-sm border border-ds-line/80 bg-ds-elevated/60 px-2 py-1.5 text-xs text-ds-ink transition duration-200 hover:border-ds-line hover:bg-ds-elevated"
                >
                  AW queue
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    downloadPlanningAuditCsv(rows)
                    toast.success('Audit CSV exported')
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-ds-sm border border-ds-line/80 bg-ds-elevated/50 px-2 py-1.5 text-xs text-ds-ink transition duration-200 hover:border-ds-line hover:bg-ds-elevated ${mono}`}
                >
                  <Download className="h-3.5 w-3.5 text-ds-ink-faint" aria-hidden />
                  Audit
                </button>
              </div>
            </div>
          }
        />
        <div className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-3 sm:gap-4">
          <div className="rounded-ds-md border border-ds-line/60 bg-ds-elevated/30 px-3 py-2">
            <p className={`text-[10px] uppercase tracking-wider text-ds-ink-faint ${mono}`}>Queue Σ qty</p>
            <p className={`text-lg font-semibold text-ds-ink ${mono}`}>{totalQty.toLocaleString('en-IN')}</p>
          </div>
          <div className="rounded-ds-md border border-ds-line/60 bg-ds-elevated/30 px-3 py-2">
            <p className={`text-[10px] uppercase tracking-wider text-ds-ink-faint ${mono}`}>Top blocker</p>
            <p className={`line-clamp-2 text-ds-ink-muted ${mono}`}>{topBlockerTile.headline}</p>
          </div>
          <div className="rounded-ds-md border border-ds-line/60 bg-ds-elevated/30 px-3 py-2">
            <p className={`text-[10px] uppercase tracking-wider text-ds-ink-faint ${mono}`}>Ready to schedule</p>
            <p className={`text-lg font-semibold text-ds-success ${mono}`}>{readyToScheduleCount}</p>
          </div>
        </div>

        {incomingFromPo.length > 0 ? (
          <div className="rounded-ds-md border border-ds-line/60 bg-ds-elevated/20 px-3 py-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-ds-ink-muted">Incoming from PO</h2>
            <div className="max-h-56 overflow-x-hidden overflow-y-auto">
              <table className="w-full table-fixed border-collapse text-left text-[12px]">
                <thead>
                  <tr className="border-b border-ds-line/50 text-[10px] uppercase text-ds-ink-faint">
                    <th className="py-2 pr-2">PO</th>
                    <th className="py-2 pr-2">Item</th>
                    <th className="py-2 pr-2">Qty</th>
                    <th className="py-2 pr-2">Tooling</th>
                    <th className="py-2 pr-2">Gate</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {incomingFromPo.map((r) => {
                    const five = readinessFiveForLine(r)
                    const busy = incomingBusy === r.id
                    const tReady = r.planningLedger?.toolingInterlock?.allReady
                    return (
                      <tr key={r.id} className="border-b border-ds-line/30">
                        <td className="py-1.5 pr-2">
                          <button
                            type="button"
                            onClick={() => setPoSummaryDrawerId(r.po.id)}
                            className={`text-left font-mono text-ds-brand underline-offset-2 transition hover:underline ${mono}`}
                          >
                            {r.po.poNumber}
                          </button>
                        </td>
                        <td className="max-w-[8rem] truncate py-1.5 pr-2 text-ds-ink" title={r.cartonName}>
                          {r.cartonName}
                        </td>
                        <td className="py-1.5 pr-2 font-medium tabular-nums text-ds-ink">{r.quantity}</td>
                        <td className="py-1.5 pr-2 text-[11px] text-ds-ink-muted">
                          {tReady ? 'Interlock OK' : 'Review'}
                        </td>
                        <td className="py-1.5 pr-2 text-[11px]">
                          {five.allGreen ? (
                            <span className="text-ds-success">Ready</span>
                          ) : (
                            <span className="text-ds-warning">Pending</span>
                          )}
                        </td>
                        <td className="py-1.5">
                          <div className="flex flex-wrap gap-1">
                            <Button
                              type="button"
                              disabled={busy}
                              onClick={() => void applyIncomingDecision(r.id, 'approve')}
                              className="h-7 px-2 py-0 text-[11px]"
                            >
                              Approve
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void applyIncomingDecision(r.id, 'hold')}
                              className="h-7 px-2 py-0 text-[11px]"
                            >
                              Hold
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void applyIncomingDecision(r.id, 'artwork')}
                              className="h-7 px-2 py-0 text-[11px]"
                            >
                              Artwork
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="px-0 py-1 space-y-2">
          <PlanningSuggestedBatchesPanel
            lines={suggestableLines}
            dismissedIds={dismissedSuggestionIds}
            onDismiss={(id) =>
              setDismissedSuggestionIds((prev) => {
                const n = new Set(prev)
                n.add(id)
                return n
              })
            }
            onAccept={(lineIds) => {
              linkLineIdsAsMixSet(lineIds)
            }}
            onModify={(lineIds) => {
              setPlanningSelection(new Set(lineIds))
              toast.info(
                lineIds.length >= 2
                  ? 'Selection ready — click Open Group Builder to review and package.'
                  : 'Select at least two lines, then open Group Builder.',
                { duration: 5000 },
              )
            }}
          />
        </div>
      </div>

      <ActionBar className="shrink-0 border-b border-ds-line/50 bg-ds-main/95 px-3 py-2">
        <div className="flex w-full min-w-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1">
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
          </div>
          <div className="flex w-full min-w-0 max-w-xl flex-1 flex-wrap items-end gap-3 text-sm">
            <div className="min-w-[240px] flex-1">
              <MasterSearchSelect
                label="Customer (API filter)"
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
                  className="mt-1 text-[10px] text-ds-ink-faint transition hover:text-ds-ink"
                >
                  Clear customer
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </ActionBar>

      {/* ── Main workspace: grid (left) + summary panel (right) ── */}
      <div className="flex min-h-0 flex-1 gap-0 overflow-hidden">
        {/* Grid — takes all remaining width */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-1 pb-0.5 pt-0.5">
          <ErrorBoundary moduleName="Planning Grid">
            <PlanningDecisionGrid
              rows={rows as PlanningGridLine[]}
              ledgerView={ledgerView}
              planningSelection={planningSelection}
              setPlanningSelection={setPlanningSelection}
              onRowBackgroundClick={(id) => {
                setPlanningDrawerLineId(id)
              }}
              updateRow={updateRow}
              onRecallLine={recallLine}
              onSaveLine={savePlanningLine}
              mixAdvisoryNote={null}
              mixConflictMessage={null}
              onBatchDecision={applyBatchDecision}
              batchActionBusy={batchActionBusy}
              highlightedRowId={highlightedRowId}
            />
          </ErrorBoundary>
        </div>

        {/* Summary panel — fixed width, full height, scrolls independently */}
        <div className="hidden w-[270px] shrink-0 overflow-hidden border-l border-ds-line/50 bg-ds-main/40 xl:flex xl:flex-col">
          <div className="shrink-0 border-b border-ds-line/50 bg-ds-elevated/10 px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-ds-ink-faint">Queue overview</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <PlanningSummaryPanel
              rows={rows}
              blockerData={blockerData}
              readyToScheduleCount={readyToScheduleCount}
              totalQty={totalQty}
            />
          </div>
        </div>
      </div>

      <footer
        className={`shrink-0 border-t border-ds-line/50 py-1.5 text-center text-[10px] text-ds-ink-faint ${mono}`}
      >
        Planning workspace
      </footer>

        <PlanningJobDetailDrawer
          line={planningDrawerLine}
          open={planningDrawerLineId != null && planningSelection.size < 2}
          onClose={() => setPlanningDrawerLineId(null)}
          onSave={save}
          onSaveLine={savePlanningLine}
          updateRow={updateRow}
          setPlanningSelection={setPlanningSelection}
          onViewProductDetail={
            planningDrawerLine?.cartonId
              ? () => setProductDrawerLine(planningDrawerLine as PlanningGridLine)
              : undefined
          }
        />
        <PlanningBatchBuilderPanel
          isOpen={batchBuilderOpen && planningSelection.size >= 2}
          onClose={() => setBatchBuilderOpen(false)}
          lines={selectedGridLines}
          onCreateBatch={linkAsMixSet}
          updateRow={updateRow}
          onSaveLine={savePlanningLine}
          onBatchDecision={applyBatchDecision}
          onMakeProcessingBatch={makeProcessingForIds}
          onRemoveFromSelection={(lineId) =>
            setPlanningSelection((prev) => {
              const next = new Set(prev)
              next.delete(lineId)
              return next
            })
          }
          onClearSelection={() => setPlanningSelection(new Set())}
        />
        <PlanningPoSummaryDrawer
          open={poSummaryDrawerId != null}
          poId={poSummaryDrawerId}
          onClose={() => setPoSummaryDrawerId(null)}
        />
        <PlanningProductDetailDrawer
          open={productDrawerLine?.cartonId != null}
          cartonId={productDrawerLine?.cartonId ?? null}
          onClose={() => setProductDrawerLine(null)}
        />
    </div>
  )
}
