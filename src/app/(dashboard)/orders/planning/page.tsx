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
import { PlanningDecisionGrid } from '@/components/planning/PlanningDecisionGrid'
import { PlanningReadinessDrawer } from '@/components/planning/PlanningReadinessDrawer'
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
  } | null
  dieMaster?: { id: string; dyeNumber: number; ups: number; sheetSize: string } | null
  createdAt?: string
}

type Customer = { id: string; name: string; contactName?: string | null }

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
  const [savingPlanningHandoff, setSavingPlanningHandoff] = useState(false)

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
        remarks: li.remarks,
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
  }, [planningSelection, fetchRows])

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
    const coatings = new Set(sel.map((r) => String(r.coatingType ?? '').trim().toLowerCase()))
    const gsms = new Set(sel.map((r) => (r.gsm != null ? String(r.gsm) : '')))
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
    <div className="min-h-screen bg-slate-900 pb-24 text-slate-100">
      <div className="mx-auto max-w-[1920px] space-y-4 px-4 py-4">
        <div className="sticky top-0 z-30 -mx-4 border-b border-slate-800 bg-slate-950/90 px-4 py-3 backdrop-blur-sm">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <div>
              <h1 className="text-base font-semibold tracking-tight text-amber-400">
                Planning
              </h1>
              <p className={`text-sm text-slate-400 ${mono}`}>
                {rows.length} line(s) · Σ qty{' '}
                <span className="font-semibold text-amber-300">{totalQty.toLocaleString('en-IN')}</span>
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 flex-1 min-w-[min(100%,16rem)]">
              <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
                View
              </span>
              <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900 p-0.5">
                <button
                  type="button"
                  onClick={() => setLedgerView('pending')}
                  className={`rounded-md px-4 py-1.5 text-sm font-medium ${
                    ledgerView === 'pending'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400'
                  }`}
                >
                  Pending
                </button>
                <button
                  type="button"
                  onClick={() => setLedgerView('processed')}
                  className={`rounded-md px-4 py-1.5 text-sm font-medium ${
                    ledgerView === 'processed'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400'
                  }`}
                >
                  Processed
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleMakeProcessing()}
                disabled={
                  planningSelection.size === 0 ||
                  makeProcessingBusy ||
                  !!selectedForMix.conflict ||
                  !!mixConflictMessage
                }
                className="rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {makeProcessingBusy ? 'Processing…' : 'Make processing'}
              </button>
              <Link
                href="/hub/dies"
                className="rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-500"
              >
                Update Dye Details
              </Link>
              <Link
                href="/orders/purchase-orders"
                className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 shadow-sm hover:bg-slate-800"
              >
                Customer POs
              </Link>
              <Link
                href="/orders/designing"
                className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 shadow-sm hover:bg-slate-800"
              >
                Artwork queue
              </Link>
              <button
                type="button"
                onClick={() => {
                  downloadPlanningAuditCsv(rows)
                  toast.success('Audit CSV exported')
                }}
                className={`inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 shadow-sm hover:bg-slate-800 ${mono}`}
              >
                <Download className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                Audit export
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-4 shadow-sm">
          <div>
            <p className={`text-[12px] uppercase tracking-wider font-medium text-slate-500 ${mono}`}>
              Total volume in queue
            </p>
            <p className={`text-xl font-semibold text-amber-300 ${mono} mt-1`}>
              {totalQty.toLocaleString('en-IN')}
            </p>
            <p className="text-[13px] text-slate-500 mt-0.5">Σ qty · all lines in view</p>
          </div>
          <div className="sm:border-l sm:border-slate-700 sm:pl-4">
            <p className={`text-[12px] uppercase tracking-wider font-medium text-slate-500 ${mono}`}>Top blocker</p>
            <p className={`text-sm font-medium text-rose-400 ${mono} leading-snug mt-1`}>
              {topBlockerTile.headline}
            </p>
            <p className="text-[13px] text-slate-500 mt-0.5">{topBlockerTile.sub}</p>
          </div>
          <div className="sm:border-l sm:border-slate-700 sm:pl-4">
            <p className={`text-[12px] uppercase tracking-wider font-medium text-slate-500 ${mono}`}>
              Ready to schedule
            </p>
            <p className={`text-xl font-semibold text-emerald-400 ${mono} mt-1`}>{readyToScheduleCount}</p>
            <p className="text-[13px] text-slate-500">5-point interlock + plates · not closed</p>
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

        <ErrorBoundary moduleName="Planning Grid">
          <PlanningDecisionGrid
            rows={rows}
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
          />
        </ErrorBoundary>

        <footer className={`border-t border-slate-800 pt-4 text-center text-[13px] text-slate-400 ${mono}`}>
          Visual Legacy Restored to 20-April State. Logic & Chronology Preserved.
        </footer>

        <PlanningReadinessDrawer
          open={planningDrawerLineId != null}
          line={
            planningDrawerLine
              ? {
                  ...planningDrawerLine,
                  po: {
                    poNumber: planningDrawerLine.po.poNumber,
                    poDate: planningDrawerLine.po.poDate,
                    customer: { name: planningDrawerLine.po.customer.name },
                  },
                }
              : null
          }
          onClose={() => setPlanningDrawerLineId(null)}
          onDesignerKeyChange={(lineId, key) => {
            const li = rows.find((x) => x.id === lineId)
            const spec = (li?.specOverrides || {}) as Record<string, unknown>
            const prev = readPlanningCore(spec)
            updateSpec(lineId, {
              planningCore: {
                ...prev,
                designerKey: key || undefined,
              },
            })
          }}
        />
      </div>
    </div>
  )
}
