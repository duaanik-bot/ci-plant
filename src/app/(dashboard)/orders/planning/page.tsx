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
  suggestNextAutoSetNumber,
  type PlanningCore,
  type PlanningDesignerKey,
  type PlanningSetIdMode,
} from '@/lib/planning-decision-spec'
import { PlanningDecisionGrid, type PlanningGridLine } from '@/components/planning/PlanningDecisionGrid'
import { PlanningJobDetailDrawer } from '@/components/planning/PlanningJobDetailDrawer'
import { PlanningSuggestedBatchesPanel } from '@/components/planning/PlanningSuggestedBatchesPanel'
import { PlanningPoSummaryDrawer } from '@/components/planning/PlanningPoSummaryDrawer'
import { PlanningProductDetailDrawer } from '@/components/planning/PlanningProductDetailDrawer'
import { ErrorBoundary } from '@/components/ErrorBoundary'
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
import {
  PlanningBatchDecisionPanel,
  type PlanningBatchPanelLine,
} from '@/components/planning/PlanningBatchDecisionPanel'

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
  const [mixConflictMessage, setMixConflictMessage] = useState<string | null>(null)
  const [planningSelection, setPlanningSelection] = useState<Set<string>>(new Set())
  const [planningGroupBy, setPlanningGroupBy] = useState<PlanningGroupBy>('none')
  const [planningSetIdMode, setPlanningSetIdMode] = useState<PlanningSetIdMode>('auto')
  const [planningDrawerLineId, setPlanningDrawerLineId] = useState<string | null>(null)
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
    return view.map(lineToSuggestable)
  }, [rows, ledgerView])

  const batchPanelLines = useMemo((): PlanningBatchPanelLine[] => {
    return rows.map((r) => ({
      id: r.id,
      poNumber: r.po.poNumber,
      cartonName: r.cartonName,
      quantity: r.quantity,
      specOverrides: (r.specOverrides as Record<string, unknown> | null) ?? null,
    }))
  }, [rows])

  const applyBatchDecision = useCallback(
    async (lineIds: string[], action: PlanningBatchDecisionAction, holdReason?: string) => {
      if (lineIds.length === 0) return
      setBatchActionBusy(true)
      try {
        const first = rows.find((r) => r.id === lineIds[0])
        if (!first) {
          toast.error('Line not found')
          return
        }
        const base = readPlanningCore(first.specOverrides as Record<string, unknown>)
        const result = applyBatchDecisionAction(base, action, { holdReason })
        if (!result) {
          toast.error('This action is not available for the current batch status')
          return
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
          const res = await fetch(`/api/planning/po-lines/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              specOverrides: { ...spec, planningCore },
              planningDecisionRevision: true,
            }),
          })
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string }
            throw new Error(j.error || 'Update failed')
          }
        }
        toast.success('Batch updated')
        await fetchRows()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Update failed')
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
      toast.error('A batch is on hold — resume the batch or exclude those lines before saving handoff')
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

  const save = async (id: string, opts?: { remarks?: string | null }) => {
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
      const remarks = opts != null && opts.remarks !== undefined ? opts.remarks : li.remarks
      const body: Record<string, unknown> = {
        setNumber: li.setNumber,
        planningStatus: li.planningStatus,
        remarks,
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

  const totalQty = useMemo(
    () => rows.reduce((sum, r) => sum + (r.quantity || 0), 0),
    [rows],
  )

  const handleMakeProcessing = useCallback(async () => {
    const ids = Array.from(planningSelection)
    if (ids.length === 0) return
    const blocked = ids.filter((id) => {
      const r = rows.find((x) => x.id === id)
      if (!r) return false
      return isBatchExcludedFromForwardSteps(readPlanningCore(r.specOverrides as Record<string, unknown>))
    })
    if (blocked.length > 0) {
      toast.error('A selected line is in a batch on hold — clear hold first')
      return
    }
    setMixConflictMessage(null)
    setMakeProcessingBusy(true)
    try {
      const res = await fetch('/api/planning/po-lines/make-processing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineIds: ids }),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setMixConflictMessage(j.error ?? 'Could not send to processing')
        toast.error(j.error ?? 'Failed')
        return
      }
      toast.success(`Sent ${ids.length} line(s) to AW queue`)
      setPlanningSelection(new Set())
      await fetchRows()
    } finally {
      setMakeProcessingBusy(false)
    }
  }, [planningSelection, rows, fetchRows])

  const recallLine = useCallback(
    async (lineId: string) => {
      try {
        const res = await fetch(`/api/planning/po-lines/${lineId}/recall-from-aw`, { method: 'POST' })
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) throw new Error(j.error || 'Recall failed')
        toast.success('Recalled — row unlocked')
        await fetchRows()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Recall failed')
      }
    },
    [fetchRows],
  )

  const handleRemoveLine = useCallback(
    async (r: Line) => {
      if (!window.confirm(`Remove PO line ${r.po.poNumber} · ${r.cartonName.slice(0, 40)} from active planning?`)) return
      try {
        const res = await fetch(`/api/planning/po-lines/${r.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planningStatus: 'closed', planningDecisionRevision: true }),
        })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((j as { error?: string }).error || 'Remove failed')
        toast.success('Line closed in planning')
        setPlanningSelection((prev) => {
          const next = new Set(prev)
          next.delete(r.id)
          return next
        })
        await fetchRows()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Remove failed')
      }
    },
    [fetchRows],
  )

  const planningDrawerLine = useMemo(
    () => (planningDrawerLineId ? rows.find((r) => r.id === planningDrawerLineId) ?? null : null),
    [rows, planningDrawerLineId],
  )

  const selectedForMix = useMemo(() => {
    const sel = Array.from(planningSelection)
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is Line => !!r)
    const coatings = new Set(
      sel.map((r) =>
        String(r.coatingType ?? r.carton?.coatingType ?? '')
          .trim()
          .toLowerCase(),
      ),
    )
    const gsms = new Set(sel.map((r) => String(r.gsm ?? r.carton?.gsm ?? '')))
    const conflict =
      sel.length >= 2 && (coatings.size > 1 || gsms.size > 1)
        ? 'Mix-Set Conflict: Specs do not match.'
        : null
    return { conflict }
  }, [planningSelection, rows])

  if (loading) {
    return (
      <div className={`min-h-[30vh] p-4 text-slate-500 ${mono}`}>Loading planning…</div>
    )
  }

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-[#0F172A] text-slate-100">
      <div className="shrink-0 space-y-2 border-b border-[#334155] bg-[#0F172A] px-3 py-2">
        <div className="flex flex-wrap items-end gap-3 justify-between">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight text-amber-400">Planning</h1>
            <p className={`text-[13px] font-medium text-slate-400 ${mono}`}>
              {rows.length} line(s) · Σ qty{' '}
              <span className="text-[#FBBF24]">{totalQty.toLocaleString('en-IN')}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">View</span>
            <div className="inline-flex rounded-lg border border-[#334155] bg-[#1E293B] p-0.5">
              <button
                type="button"
                onClick={() => setLedgerView('pending')}
                className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
                  ledgerView === 'pending' ? 'bg-[#2563EB] text-white' : 'text-slate-400'
                }`}
              >
                Pending
              </button>
              <button
                type="button"
                onClick={() => setLedgerView('processed')}
                className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
                  ledgerView === 'processed' ? 'bg-[#2563EB] text-white' : 'text-slate-400'
                }`}
              >
                Processed
              </button>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleMakeProcessing()}
              disabled={
                planningSelection.size === 0 ||
                makeProcessingBusy ||
                !!selectedForMix.conflict ||
                !!mixConflictMessage
              }
              className="rounded-lg bg-amber-600 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {makeProcessingBusy ? 'Processing…' : 'Make processing'}
            </button>
            <Link
              href="/hub/dies"
              className="rounded-lg bg-amber-600 px-3 py-2 text-[13px] font-semibold text-white hover:bg-amber-500"
            >
              Dyes
            </Link>
            <Link
              href="/orders/purchase-orders"
              className="rounded-lg border border-[#334155] bg-[#1E293B] px-2 py-1.5 text-xs text-slate-200"
            >
              POs
            </Link>
            <Link
              href="/orders/designing"
              className="rounded-lg border border-[#334155] bg-[#1E293B] px-2 py-1.5 text-xs text-slate-200"
            >
              AW queue
            </Link>
            <button
              type="button"
              onClick={() => {
                downloadPlanningAuditCsv(rows)
                toast.success('Audit CSV exported')
              }}
              className={`inline-flex items-center gap-1.5 rounded-lg border border-[#334155] bg-[#1E293B] px-2 py-1.5 text-xs text-slate-200 ${mono}`}
            >
              <Download className="h-3.5 w-3.5 text-slate-500" aria-hidden />
              Audit
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-4 text-[13px]">
          <div className="rounded border border-[#334155] bg-[#1E293B] px-2 py-1.5">
            <p className={`text-[10px] uppercase tracking-wider text-slate-500 ${mono}`}>Queue Σ qty</p>
            <p className={`text-lg font-semibold text-[#FBBF24] ${mono}`}>{totalQty.toLocaleString('en-IN')}</p>
          </div>
          <div className="rounded border border-[#334155] bg-[#1E293B] px-2 py-1.5">
            <p className={`text-[10px] uppercase tracking-wider text-slate-500 ${mono}`}>Top blocker</p>
            <p className={`line-clamp-2 text-slate-200 ${mono}`}>{topBlockerTile.headline}</p>
          </div>
          <div className="rounded border border-[#334155] bg-[#1E293B] px-2 py-1.5">
            <p className={`text-[10px] uppercase tracking-wider text-slate-500 ${mono}`}>Ready to schedule</p>
            <p className={`text-lg font-semibold text-[#34D399] ${mono}`}>{readyToScheduleCount}</p>
          </div>
        </div>

        {incomingFromPo.length > 0 ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-950/15 px-2 py-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-amber-400">Incoming from PO</h2>
            <p className="mb-2 text-[11px] text-slate-500">
              Newly released customer POs—confirm tooling path before deep planning.
            </p>
            <div className="max-h-56 overflow-auto">
              <table className="w-full border-collapse text-left text-[12px]">
                <thead>
                  <tr className="border-b border-slate-600 text-[10px] uppercase text-slate-500">
                    <th className="py-1 pr-2">PO</th>
                    <th className="py-1 pr-2">Item</th>
                    <th className="py-1 pr-2">Qty</th>
                    <th className="py-1 pr-2">Tooling</th>
                    <th className="py-1 pr-2">Gate</th>
                    <th className="py-1">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {incomingFromPo.map((r) => {
                    const five = readinessFiveForLine(r)
                    const busy = incomingBusy === r.id
                    const tReady = r.planningLedger?.toolingInterlock?.allReady
                    return (
                      <tr key={r.id} className="border-b border-slate-800/90">
                        <td className="py-1.5 pr-2">
                          <button
                            type="button"
                            onClick={() => setPoSummaryDrawerId(r.po.id)}
                            className={`text-left font-mono text-amber-200/95 underline-offset-2 hover:underline ${mono}`}
                          >
                            {r.po.poNumber}
                          </button>
                        </td>
                        <td className="max-w-[8rem] truncate py-1.5 pr-2" title={r.cartonName}>
                          {r.cartonName}
                        </td>
                        <td className="py-1.5 pr-2 tabular-nums text-slate-200">{r.quantity}</td>
                        <td className="py-1.5 pr-2 text-[11px] text-slate-400">
                          {tReady ? 'Interlock OK' : 'Review'}
                        </td>
                        <td className="py-1.5 pr-2 text-[11px]">
                          {five.allGreen ? (
                            <span className="text-emerald-400">Ready</span>
                          ) : (
                            <span className="text-amber-300">Pending</span>
                          )}
                        </td>
                        <td className="py-1.5">
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void applyIncomingDecision(r.id, 'approve')}
                              className="rounded bg-emerald-800/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void applyIncomingDecision(r.id, 'hold')}
                              className="rounded bg-amber-800/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Hold
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void applyIncomingDecision(r.id, 'artwork')}
                              className="rounded bg-sky-800/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Artwork
                            </button>
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
              toast.info(`${lineIds.length} line(s) selected — adjust in the grid, then use Link as mix set or save per row.`, {
                duration: 5000,
              })
            }}
          />
          <PlanningBatchDecisionPanel
            lines={batchPanelLines}
            onApply={(lineIds, action, holdReason) => applyBatchDecision(lineIds, action, holdReason)}
            busy={batchActionBusy}
          />
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

        <div className="flex flex-wrap gap-3 text-sm items-end max-w-xl">
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
                className="mt-1 text-[10px] text-slate-500 hover:text-slate-300"
              >
                Clear customer
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden px-2 pb-1 pt-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ErrorBoundary moduleName="Planning Grid">
            <PlanningDecisionGrid
              rows={rows as PlanningGridLine[]}
              ledgerView={ledgerView}
              planningSelection={planningSelection}
              setPlanningSelection={setPlanningSelection}
              onRowBackgroundClick={(id) => setPlanningDrawerLineId(id)}
              updateSpec={(id, patch) => updateSpec(id, patch as Partial<PlanningSpec>)}
              updateRow={updateRow}
              onRemoveLine={handleRemoveLine}
              onRecallLine={recallLine}
              onSaveRow={save}
              mixConflictMessage={mixConflictMessage ?? selectedForMix.conflict}
              onLinkAsMixSet={linkAsMixSet}
              onPONumberClick={(poId) => setPoSummaryDrawerId(poId)}
              onCartonClick={(line) => setProductDrawerLine(line)}
            />
          </ErrorBoundary>
        </div>
        {planningDrawerLineId != null && planningDrawerLine ? (
          <PlanningJobDetailDrawer
            line={planningDrawerLine}
            open
            onClose={() => setPlanningDrawerLineId(null)}
            onSave={save}
            updateRow={updateRow}
            setPlanningSelection={setPlanningSelection}
          />
        ) : null}
      </div>

        <footer className={`shrink-0 border-t border-[#334155] py-2 text-center text-[13px] text-slate-500 ${mono}`}>
          Enterprise Intelligence Active - Decisions Synchronized with April 20th Global Theme.
        </footer>

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
