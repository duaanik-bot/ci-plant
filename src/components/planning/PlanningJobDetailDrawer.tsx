'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Layers, PauseCircle, Star } from 'lucide-react'
import { toast } from 'sonner'
import { broadcastIndustrialPriorityChange } from '@/lib/industrial-priority-sync'
import { INDUSTRIAL_PRIORITY_STAR_ICON_CLASS } from '@/lib/industrial-priority-ui'
import {
  MASTER_EMBOSSING_AND_LEAFING,
} from '@/lib/master-enums'
import { useMaster } from '@/components/masters/MastersProvider'
import { MASTER } from '@/lib/masters/registry'
import { mergePlanningMetaUps, readPlanningMeta, PLANNING_DESIGNERS } from '@/lib/planning-decision-spec'
import { resolveSheetSize, resolveUps } from '@/lib/production-os-resolvers'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { PlanningGridLine, type PlanningLineFieldPatch } from '@/components/planning/PlanningDecisionGrid'
import { PlanningEngineModal } from '@/components/planning/PlanningEngineModal'
import { PlanningEngineBody } from '@/components/planning/engine/PlanningEngineBody'
import { WarehousePopup } from '@/components/planning/engine/WarehousePopup'
import { buildEngineLine } from '@/components/planning/engine/buildEngineLine'
import type { PlanningEngineLine, PlanningEngineReadiness } from '@/components/planning/engine/types'
import { scoreGangSuggestions, type GangLine } from '@/lib/planning-smart-match'
import { CardSection } from '@/components/design-system/CardSection'
import { Button } from '@/components/design-system/Button'
import { Badge } from '@/components/design-system/Badge'

type Props = {
  line: (PlanningGridLine & {
    directorPriority?: boolean
    directorHold?: boolean
    materialQueue?: { boardType?: string | null; sheetLengthMm?: unknown; sheetWidthMm?: unknown } | null
  }) | null
  open: boolean
  onClose: () => void
  onSave: (lineId: string, opts?: { remarks?: string | null }) => Promise<void>
  onSaveLine: (
    lineId: string,
    patch: PlanningLineFieldPatch,
    specSnapshot?: Record<string, unknown> | null,
  ) => Promise<boolean>
  updateRow: (id: string, patch: Record<string, unknown>) => void
  setPlanningSelection: React.Dispatch<React.SetStateAction<Set<string>>>
  /** When linked carton exists, opens product detail (e.g. from planning page). */
  onViewProductDetail?: () => void
}

const mono = 'font-designing-queue tabular-nums tracking-tight'

type MaterialReadinessPanelData = {
  materialId: string | null
  materialCode: string | null
  boardType: string | null
  boardClassification: string | null
  size: string | null
  gsm: number | null
  requiredSheets: number
  availableSheets: number
  reservedSheets: number
  freeSheets?: number
  incomingSheets: number
  shortageSheets: number
  shortageId?: string | null
  prId?: string | null
  prStatus: string
  grnEta: string | null
  qty?: number
  ups?: number
  wastageSheets?: number
  baseRequiredSheets?: number
  requiredFinalSize?: string | null
  gsmTolerance?: number
  suggestedBoardOptions?: Array<{
    materialId: string
    materialCode: string
    boardType: string | null
    boardClassification: string | null
    gsm: number | null
    size: string
    availableSheets: number
    reservedSheets: number
    freeSheets: number
    cutsPerSheet: number
    requiredParentSheets: number
    shortageParentSheets: number
    wastagePct: number
    sizeDeviationPct?: number
    fitScore?: number
    yieldPct: number
    orientation: 'LxW' | 'WxL'
    matchType: 'Cut Fit' | 'Direct Size' | 'Special Cut' | 'GSM Tolerance' | 'Compatible Size' | 'Fallback Option'
    status: 'Ready' | 'Partial' | 'Shortage'
    tags: Array<'Best Yield' | 'Lowest Wastage' | 'Closest GSM' | 'Most Available' | 'Exact Match' | 'GSM Tolerance' | 'Compatible Size' | 'Fallback Option' | 'Leftover Stock' | 'Leftover Reuse'>
    gsmDelta: number | null
    sizeDiff?: number
    matchRank?: number
    isLeftover?: boolean
    sourceTraceability?: string | null
    boardMatchMode?: 'exact' | 'cross_field' | 'fallback'
  }>
  closestAvailableOptions?: Array<{
    materialId: string
    materialCode: string
    boardType: string | null
    boardClassification: string | null
    gsm: number | null
    size: string
    availableSheets: number
    reservedSheets: number
    freeSheets: number
    cutsPerSheet: number
    requiredParentSheets: number
    shortageParentSheets: number
    wastagePct: number
    sizeDeviationPct?: number
    fitScore?: number
    yieldPct: number
    orientation: 'LxW' | 'WxL'
    matchType: 'Cut Fit' | 'Direct Size' | 'Special Cut' | 'GSM Tolerance' | 'Compatible Size' | 'Fallback Option'
    status: 'Ready' | 'Partial' | 'Shortage'
    tags: Array<'Best Yield' | 'Lowest Wastage' | 'Closest GSM' | 'Most Available' | 'Exact Match' | 'GSM Tolerance' | 'Compatible Size' | 'Fallback Option' | 'Leftover Stock' | 'Leftover Reuse'>
    gsmDelta: number | null
    sizeDiff?: number
    matchRank?: number
    isLeftover?: boolean
    sourceTraceability?: string | null
    boardMatchMode?: 'exact' | 'cross_field' | 'fallback'
  }>
  noMaterialsAtAll?: boolean
  debugMessage?: string | null
  suggestionDebug?: {
    requiredSize: string | null
    requiredGsm: number | null
    tolerance: number
    boardType: string | null
    boardClassification: string | null
    materialsFetched: number
    afterGsmFilter: number
    afterSizeFit: number
    finalSuggestions: number
    fallbackWithoutClassification: number
    fallbackWithWiderTolerance: number
  } | null
  mappingSafety?: {
    requestedBoardType: string | null
    requestedBoardClassification: string | null
    candidatePoolCount: number
    strictPoolCount: number
    strategyUsed: string
  } | null
  status: 'green' | 'yellow' | 'red' | 'grey'
  reservedForLine?: number
  reservedByMaterial?: Record<string, number>
  materialCandidates?: Array<{ id: string; materialCode: string; description: string }>
  materialMatchState?: 'matched' | 'multiple' | 'none' | 'unknown'
}

type MaterialStockDetails = {
  material: {
    id: string
    materialCode: string
    description: string
    boardType: string | null
    boardClassification: string | null
    gsm: number | null
    sheetLength: number | null
    sheetWidth: number | null
  }
  logs: Array<{
    id: string
    movementType: string
    qty: number
    refType: string | null
    refId: string | null
    createdAt: string
  }>
  reservations: Array<{
    id: string
    planningId?: string | null
    poNumber?: string | null
    requiredSheets: number
    reservedSheets: number
    status: string
    reservedAt?: string | null
    cartonName: string | null
    jobCard: { jobCardNumber: number; status: string } | null
  }>
  shortages: Array<{
    id: string
    jobCardNumber: number | null
    pendingShortage: number
    requiredQty: number
    priority: 'urgent' | 'normal'
    requiredByDate: string | null
  }>
}

type ReserveConfirmDraft = {
  materialId: string
  materialCode: string
  parentSize: string
  gsm: number | null
  cutsPerSheet: number
  requiredParentSheets: number
  availableSheets: number
  reservedSheets: number
  freeSheets: number
  alreadyReservedSheets: number
  currentShortageSheets: number
  reserveQtyInput: string
  reserveQty: number
  shortageQty: number
  prQtyInput: string
  prQty: number
  leftoverAvailableAfterReserve: number
  currentReservedForLine: number
  finalRequiredSheets: number
  calculatedCutsPerSheet: number
  selectedCutsPerSheetInput: string
  isCutsManualOverride: boolean
  overrideReason: string
  selectedReason: string
  leftoverLengthInput: string
  leftoverWidthInput: string
  leftoverQtyInput: string
  leftoverRemarks: string
  addLeftoverToWarehouse: boolean
  leftoverWeightKg: number
  cutSizeUsed: string
}

type ReservationUndoState = {
  materialId: string
  requiredSheets: number
  targetReserveQty: number
  prQty: number
  label: string
}

type ReservationControlMode = 'adjust' | 'release' | 'generate_pr'

type ReservationControlDraft = {
  mode: ReservationControlMode
  materialId: string
  materialCode: string
  requiredSheets: number
  availableSheets: number
  reservedSheetsTotal: number
  currentReservedForLine: number
  currentShortageSheets: number
  prId: string | null
  prStatus: string
  prQtyCurrent: number
  reserveQtyInput: string
  reserveQty: number
  releaseQtyInput: string
  releaseQty: number
  prQtyInput: string
  prQty: number
  shortageQty: number
  leftoverAvailableAfterReserve: number
  prImpactAction: 'keep' | 'reduce' | 'cancel_if_no_shortage'
  warningMessage: string | null
  jobCardStatus: string | null
}

function specFoil(line: PlanningGridLine): string {
  const s = (line.specOverrides || {}) as Record<string, unknown>
  const f = s.foilType
  return typeof f === 'string' && f.trim() ? f.trim() : ''
}

function specPasting(line: PlanningGridLine): string {
  const s = (line.specOverrides || {}) as Record<string, unknown>
  const t = s.pastingType
  if (typeof t === 'string' && t.trim()) return t.trim()
  const st = s.pastingStyle
  if (typeof st === 'string' && st.trim()) return st.trim()
  return ''
}

function toPositiveNumberString(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  return String(n)
}

function parseSizePair(raw: string): { length: number; width: number } | null {
  const txt = String(raw || '').trim()
  if (!txt) return null
  const parts = txt
    .replace(/[×*]/g, 'x')
    .split('x')
    .map((p) => Number(p.trim()))
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null
  const length = Number(parts[0])
  const width = Number(parts[1])
  if (length <= 0 || width <= 0) return null
  return { length, width }
}

function computeReserveDraftFromCuts(
  prev: ReserveConfirmDraft,
  nextCuts: number,
  preservePrEdit: boolean,
): ReserveConfirmDraft {
  const cuts = Math.max(1, nextCuts)
  const requiredParentSheets = Math.max(1, Math.ceil(prev.finalRequiredSheets / cuts))
  const free = Math.max(0, prev.freeSheets)
  const reserveQty = Math.min(requiredParentSheets, free)
  const shortageQty = Math.max(0, requiredParentSheets - reserveQty)
  const prQty = preservePrEdit ? prev.prQty : shortageQty
  const prQtyInput = preservePrEdit ? prev.prQtyInput : String(shortageQty)
  const leftoverAvailableAfterReserve = Math.max(0, free - reserveQty)
  const leftoverQty = Number(prev.leftoverQtyInput) || 0
  const leftoverLength = Number(prev.leftoverLengthInput) || 0
  const leftoverWidth = Number(prev.leftoverWidthInput) || 0
  const gsm = Number(prev.gsm || 0)
  const leftoverWeightKg = Number(((leftoverLength * leftoverWidth * gsm * leftoverQty) / 1000000).toFixed(6))
  return {
    ...prev,
    cutsPerSheet: cuts,
    selectedCutsPerSheetInput: String(cuts),
    requiredParentSheets,
    reserveQty,
    reserveQtyInput: String(reserveQty),
    shortageQty,
    prQty,
    prQtyInput,
    leftoverAvailableAfterReserve,
    leftoverWeightKg,
  }
}

export function PlanningJobDetailDrawer({
  line,
  open,
  onClose,
  onSave,
  onSaveLine,
  updateRow,
  setPlanningSelection,
  onViewProductDetail,
}: Props) {
  const [remarksDraft, setRemarksDraft] = useState('')
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitA, setSplitA] = useState<number | ''>('')
  const [saving, setSaving] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [saveMasterBusy, setSaveMasterBusy] = useState(false)
  const [reserveBusy, setReserveBusy] = useState(false)
  const [sheetLengthMm, setSheetLengthMm] = useState('')
  const [sheetWidthMm, setSheetWidthMm] = useState('')
  const [wastageSheetsInput, setWastageSheetsInput] = useState('150')
  const [boardTypeOptions, setBoardTypeOptions] = useState<string[]>([])
  const coatingMaster = useMaster(MASTER.COATING)
  const coatingOptions = coatingMaster.options.map((o) => o.label)
  const [readiness, setReadiness] = useState<MaterialReadinessPanelData | null>(null)
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [selectedMaterialId, setSelectedMaterialId] = useState<string>('')
  const [selectionLocked, setSelectionLocked] = useState(false)
  const [stockDetailsOpen, setStockDetailsOpen] = useState(false)
  const [stockDetailsLoading, setStockDetailsLoading] = useState(false)
  const [stockDetails, setStockDetails] = useState<MaterialStockDetails | null>(null)
  const [optionDetailsOpen, setOptionDetailsOpen] = useState<Record<string, boolean>>({})
  const [optionDetailsLoading, setOptionDetailsLoading] = useState<Record<string, boolean>>({})
  const [optionDetailsByMaterial, setOptionDetailsByMaterial] = useState<Record<string, MaterialStockDetails | null>>({})
  const [suggestionsWorkspaceOpen, setSuggestionsWorkspaceOpen] = useState(false)
  const [reserveInlineError, setReserveInlineError] = useState<string | null>(null)
  const [reserveConfirmOpen, setReserveConfirmOpen] = useState(false)
  const [reserveConfirm, setReserveConfirm] = useState<ReserveConfirmDraft | null>(null)
  const [reserveModalError, setReserveModalError] = useState<string | null>(null)
  const [reservePrEdited, setReservePrEdited] = useState(false)
  const [undoState, setUndoState] = useState<ReservationUndoState | null>(null)
  const [reservationControlOpen, setReservationControlOpen] = useState(false)
  const [reservationControlBusy, setReservationControlBusy] = useState(false)
  const [reservationControlError, setReservationControlError] = useState<string | null>(null)
  const [reservationControl, setReservationControl] = useState<ReservationControlDraft | null>(null)
  const [workspaceSortKey, setWorkspaceSortKey] = useState<'fit' | 'wastage' | 'sizeDeviation' | 'cuts' | 'free' | 'gsmDelta' | 'leftover' | 'gsm' | 'required'>('fit')
  const [workspaceSortDir, setWorkspaceSortDir] = useState<'asc' | 'desc'>('desc')
  const [gangSuggestions, setGangSuggestions] = useState<NonNullable<PlanningEngineLine['smartMatch']>['suggestions']>([])
  const [warehousePopupOpen, setWarehousePopupOpen] = useState(false)

  useEffect(() => {
    if (!line?.id) { setGangSuggestions([]); return }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/planning/po-lines/${line.id}/gang-candidates`, { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        const candidates = Array.isArray(data?.candidates) ? data.candidates : []
        const meta = readPlanningMeta((line.specOverrides ?? {}) as Record<string, unknown>)
        const anchorTop = readiness?.suggestedBoardOptions?.[0] ?? readiness?.closestAvailableOptions?.[0] ?? null
        const toGangLine = (row: Record<string, unknown>, isAnchor: boolean): GangLine => {
          const spec = (row.specOverrides ?? {}) as Record<string, unknown>
          const m = readPlanningMeta(spec)
          const po = (row.po ?? {}) as { poNumber?: string; deliveryRequiredBy?: string | null }
          const deliveryDays = po.deliveryRequiredBy
            ? Math.max(0, Math.round((new Date(po.deliveryRequiredBy).getTime() - Date.now()) / 86400000))
            : null
          return {
            id: String(row.id ?? ''),
            quantity: Number(row.quantity ?? 0),
            ups: Math.max(1, Number(m.ups ?? 1)),
            sheetSize: (m.parentSize as string) ?? null,
            gsm: row.gsm != null ? Number(row.gsm) : null,
            boardType: (row.paperType as string) ?? null,
            coating: (row.coatingType as string) ?? null,
            printSide: (m.printSide as string) ?? (spec.printSide as string) ?? null,
            deliveryDays,
            yieldPct: isAnchor ? Number(anchorTop?.yieldPct ?? 80) : 80,
            poRef: po.poNumber,
          }
        }
        const anchor = toGangLine(line as unknown as Record<string, unknown>, true)
        const scored = scoreGangSuggestions(anchor, candidates.map((c: Record<string, unknown>) => toGangLine(c, false)), {})
        if (!cancelled) setGangSuggestions(scored)
      } catch {
        if (!cancelled) setGangSuggestions([])
      }
    })()
    return () => { cancelled = true }
  }, [line, readiness])

  useEffect(() => {
    if (!line) {
      setRemarksDraft('')
      return
    }
    setRemarksDraft(line.remarks ?? '')
    setSplitOpen(false)
    setSplitA('')
    const spec = (line.specOverrides || {}) as Record<string, unknown>
    setSheetLengthMm(
      toPositiveNumberString(spec.sheetLengthMm) ||
        toPositiveNumberString(line.materialQueue?.sheetLengthMm) ||
        toPositiveNumberString(line.carton?.blankLength),
    )
    setSheetWidthMm(
      toPositiveNumberString(spec.sheetWidthMm) ||
        toPositiveNumberString(line.materialQueue?.sheetWidthMm) ||
        toPositiveNumberString(line.carton?.blankWidth),
    )
    const ws = Math.max(0, Math.floor(Number((spec.wastageSheets as number | undefined) ?? 150)))
    setWastageSheetsInput(String(Number.isFinite(ws) ? ws : 150))
    setSelectionLocked(false)
  }, [line?.id, line?.remarks])

  useEffect(() => {
    setSelectedMaterialId('')
    setReadiness(null)
    setStockDetails(null)
    setStockDetailsOpen(false)
    setOptionDetailsOpen({})
    setOptionDetailsByMaterial({})
    setOptionDetailsLoading({})
    setSuggestionsWorkspaceOpen(false)
  }, [line?.id])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const materialsRes = await fetch('/api/masters/materials', { cache: 'no-store' })
        if (cancelled) return
        if (materialsRes.ok) {
          const data = (await materialsRes.json()) as Array<{ boardType?: string | null }>
          const values = Array.from(
            new Set(
              (Array.isArray(data) ? data : [])
                .map((m) => (typeof m?.boardType === 'string' ? m.boardType.trim() : ''))
                .filter(Boolean),
            ),
          )
          setBoardTypeOptions(values)
        }
      } catch {
        /* keep existing values */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const loadReadiness = useCallback(async () => {
    if (!line) {
      setReadiness(null)
      return
    }
    setReadinessLoading(true)
    try {
      const spec = (line.specOverrides || {}) as Record<string, unknown>
      const meta = readPlanningMeta(spec)
      const qty = Math.max(1, Math.floor(Number(line.quantity || 1)))
      const ups = Math.max(1, Math.floor(Number(meta.ups || 1)))
      const wastageSheets = Math.max(0, Math.floor(Number(wastageSheetsInput || 0)))
      const params = new URLSearchParams()
      if (selectedMaterialId) params.set('materialId', selectedMaterialId)
      params.set('qty', String(qty))
      params.set('ups', String(ups))
      params.set('wastageSheets', String(wastageSheets))
      const res = await fetch(`/api/planning/po-lines/${line.id}/reserve-material?${params.toString()}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Could not load material readiness')
      const out = data as Partial<MaterialReadinessPanelData>
      setReadiness({
        materialId: typeof out.materialId === 'string' ? out.materialId : null,
        materialCode: typeof out.materialCode === 'string' ? out.materialCode : null,
        boardType: typeof out.boardType === 'string' ? out.boardType : null,
        boardClassification: typeof out.boardClassification === 'string' ? out.boardClassification : null,
        size: typeof out.size === 'string' ? out.size : null,
        gsm: typeof out.gsm === 'number' && Number.isFinite(out.gsm) ? out.gsm : null,
        requiredSheets: Number(out.requiredSheets) || 0,
        availableSheets: Number(out.availableSheets) || 0,
        reservedSheets: Number(out.reservedSheets) || 0,
        freeSheets: Number(out.freeSheets),
        incomingSheets: Number(out.incomingSheets) || 0,
        shortageSheets: Number(out.shortageSheets) || 0,
        shortageId: typeof out.shortageId === 'string' ? out.shortageId : null,
        prId: typeof out.prId === 'string' ? out.prId : null,
        prStatus: typeof out.prStatus === 'string' ? out.prStatus : 'not_created',
        grnEta: typeof out.grnEta === 'string' ? out.grnEta : null,
        qty: Number(out.qty) || 0,
        ups: Number(out.ups) || 0,
        wastageSheets: Number(out.wastageSheets) || 0,
        baseRequiredSheets: Number(out.baseRequiredSheets) || 0,
        requiredFinalSize: typeof out.requiredFinalSize === 'string' ? out.requiredFinalSize : null,
        gsmTolerance: Number(out.gsmTolerance) || 10,
        suggestedBoardOptions: Array.isArray(out.suggestedBoardOptions)
          ? out.suggestedBoardOptions.filter(
              (
                o,
              ): o is NonNullable<MaterialReadinessPanelData['suggestedBoardOptions']>[number] =>
                !!o && typeof o.materialId === 'string' && typeof o.materialCode === 'string' && typeof o.size === 'string',
            )
          : [],
        closestAvailableOptions: Array.isArray(out.closestAvailableOptions)
          ? out.closestAvailableOptions.filter(
              (
                o,
              ): o is NonNullable<MaterialReadinessPanelData['closestAvailableOptions']>[number] =>
                !!o && typeof o.materialId === 'string' && typeof o.materialCode === 'string' && typeof o.size === 'string',
            )
          : [],
        noMaterialsAtAll: Boolean(out.noMaterialsAtAll),
        debugMessage: typeof out.debugMessage === 'string' ? out.debugMessage : null,
        suggestionDebug:
          out.suggestionDebug && typeof out.suggestionDebug === 'object'
            ? (out.suggestionDebug as MaterialReadinessPanelData['suggestionDebug'])
            : null,
        mappingSafety:
          out.mappingSafety && typeof out.mappingSafety === 'object'
            ? (out.mappingSafety as MaterialReadinessPanelData['mappingSafety'])
            : null,
        status:
          out.status === 'green' || out.status === 'yellow' || out.status === 'red' || out.status === 'grey'
            ? out.status
            : 'grey',
        reservedForLine: Math.max(0, Number(out.reservedForLine || 0)),
        reservedByMaterial:
          out.reservedByMaterial && typeof out.reservedByMaterial === 'object'
            ? (out.reservedByMaterial as Record<string, number>)
            : {},
        materialCandidates: Array.isArray(out.materialCandidates)
          ? out.materialCandidates.filter(
              (v): v is { id: string; materialCode: string; description: string } =>
                !!v && typeof v.id === 'string',
            )
          : [],
        materialMatchState:
          out.materialMatchState === 'matched' ||
          out.materialMatchState === 'multiple' ||
          out.materialMatchState === 'none' ||
          out.materialMatchState === 'unknown'
            ? out.materialMatchState
            : 'unknown',
      })
      setSelectedMaterialId((curr) => curr || '')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load material readiness')
      setReadiness(null)
    } finally {
      setReadinessLoading(false)
    }
  }, [line, selectedMaterialId, wastageSheetsInput])

  const loadStockDetails = useCallback(async (materialId: string) => {
    if (!materialId) return
    setStockDetailsLoading(true)
    try {
      const res = await fetch(`/api/inventory/paper-warehouse/${materialId}/details`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to load stock details')
      setStockDetails(data as MaterialStockDetails)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load stock details')
      setStockDetails(null)
    } finally {
      setStockDetailsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadReadiness()
  }, [loadReadiness])

  useEffect(() => {
    if (!stockDetailsOpen) return
    const mid = selectedMaterialId || readiness?.materialId || ''
    if (!mid) return
    void loadStockDetails(mid)
  }, [stockDetailsOpen, selectedMaterialId, readiness?.materialId, loadStockDetails])

  const handleSave = useCallback(async () => {
    if (!line) return
    setSaving(true)
    try {
      const nextRemarks = remarksDraft.trim() || null
      updateRow(line.id, { remarks: nextRemarks })
      await onSave(line.id, { remarks: nextRemarks })
      onClose()
    } catch {
      /* parent toasts */
    } finally {
      setSaving(false)
    }
  }, [line, remarksDraft, onSave, onClose, updateRow])

  const getSuggestionOption = useCallback((materialId: string) => {
    return (
      (readiness?.suggestedBoardOptions || []).find((o) => o.materialId === materialId) ||
      (readiness?.closestAvailableOptions || []).find((o) => o.materialId === materialId) ||
      null
    )
  }, [readiness?.suggestedBoardOptions, readiness?.closestAvailableOptions])

  const visibleSuggestionOptions = useMemo(
    () =>
      (
        ((readiness?.suggestedBoardOptions?.length || 0) > 0
          ? readiness?.suggestedBoardOptions
          : readiness?.closestAvailableOptions) || []
      ).slice(0, 10),
    [readiness?.closestAvailableOptions, readiness?.suggestedBoardOptions],
  )

  const mainSuggestionOptions = useMemo(
    () =>
      [...visibleSuggestionOptions].slice(0, 3),
    [visibleSuggestionOptions],
  )

  const workspaceSuggestionOptions = useMemo(() => {
    const rows = [...visibleSuggestionOptions]
    rows.sort((a, b) => {
      const dir = workspaceSortDir === 'asc' ? 1 : -1
      if (workspaceSortKey === 'fit') return ((a.fitScore ?? 0) - (b.fitScore ?? 0)) * dir
      if (workspaceSortKey === 'wastage') return (a.wastagePct - b.wastagePct) * dir
      if (workspaceSortKey === 'sizeDeviation') return ((a.sizeDeviationPct ?? 0) - (b.sizeDeviationPct ?? 0)) * dir
      if (workspaceSortKey === 'cuts') return (a.cutsPerSheet - b.cutsPerSheet) * dir
      if (workspaceSortKey === 'free') return (a.freeSheets - b.freeSheets) * dir
      if (workspaceSortKey === 'gsmDelta') return ((a.gsmDelta ?? Number.MAX_SAFE_INTEGER) - (b.gsmDelta ?? Number.MAX_SAFE_INTEGER)) * dir
      if (workspaceSortKey === 'leftover') return ((a.isLeftover ? 1 : 0) - (b.isLeftover ? 1 : 0)) * dir
      if (workspaceSortKey === 'gsm') return ((a.gsm ?? 0) - (b.gsm ?? 0)) * dir
      return (a.requiredParentSheets - b.requiredParentSheets) * dir
    })
    return rows
  }, [visibleSuggestionOptions, workspaceSortDir, workspaceSortKey])

  const designerOptions = useMemo(
    () =>
      (Object.entries(PLANNING_DESIGNERS) as [string, string][]).map(([id, name]) => ({ id, name })),
    [],
  )

  const engineLine = useMemo(
    () =>
      line
        ? buildEngineLine(
            line as unknown as PlanningGridLine,
            readiness as unknown as PlanningEngineReadiness | null,
            { designerOptions, smartMatchSuggestions: gangSuggestions },
          )
        : null,
    [line, readiness, designerOptions, gangSuggestions],
  )

  const toggleWorkspaceSort = useCallback(
    (key: 'fit' | 'wastage' | 'sizeDeviation' | 'cuts' | 'free' | 'gsmDelta' | 'leftover' | 'gsm' | 'required') => {
      if (workspaceSortKey === key) {
        setWorkspaceSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
        return
      }
      setWorkspaceSortKey(key)
      setWorkspaceSortDir(
        key === 'fit' || key === 'cuts' || key === 'free' || key === 'leftover'
          ? 'desc'
          : 'asc',
      )
    },
    [workspaceSortKey],
  )

  const loadOptionDetails = useCallback(async (materialId: string) => {
    if (!materialId) return
    setOptionDetailsLoading((prev) => ({ ...prev, [materialId]: true }))
    try {
      const res = await fetch(`/api/inventory/paper-warehouse/${materialId}/details`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to load details')
      setOptionDetailsByMaterial((prev) => ({ ...prev, [materialId]: data as MaterialStockDetails }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load details')
      setOptionDetailsByMaterial((prev) => ({ ...prev, [materialId]: null }))
    } finally {
      setOptionDetailsLoading((prev) => ({ ...prev, [materialId]: false }))
    }
  }, [])

  const lockSelectionOnly = useCallback(async (materialIdArg?: string, cutsPerSheetArg?: number, parentSizeArg?: string) => {
    if (!line) return
    const chosenMaterialId = materialIdArg || selectedMaterialId || readiness?.materialId || ''
    if (!chosenMaterialId) {
      toast.error('Select a material first')
      return
    }
    const option =
      cutsPerSheetArg && parentSizeArg
        ? ({ cutsPerSheet: cutsPerSheetArg, size: parentSizeArg, requiredParentSheets: 0 } as const)
        : getSuggestionOption(chosenMaterialId)
    const specNow = (line.specOverrides || {}) as Record<string, unknown>
    const specMeta = readPlanningMeta(specNow)
    const nextSpec: Record<string, unknown> = {
      ...specNow,
      planningMaterialId: chosenMaterialId,
      meta: {
        ...specMeta,
        cutsPerSheet: Number(option?.cutsPerSheet || 0),
        parentSize: String(option?.size || ''),
        requiredParentSheets: Number(option?.requiredParentSheets || 0),
      },
    }
    updateRow(line.id, { specOverrides: nextSpec })
    await onSaveLine(line.id, { specOverrides: nextSpec })
    setSelectedMaterialId(chosenMaterialId)
    setSelectionLocked(true)
    await loadReadiness()
    toast.success('Material locked for planning.')
  }, [line, selectedMaterialId, readiness?.materialId, getSuggestionOption, updateRow, onSaveLine, loadReadiness])

  const openReserveConfirmation = useCallback((materialIdArg?: string, cutsPerSheetArg?: number, parentSizeArg?: string) => {
    if (!line) return
    setReserveInlineError(null)
    setReserveModalError(null)
    const chosenMaterialId = materialIdArg || selectedMaterialId || readiness?.materialId || ''
    const spec = (line.specOverrides || {}) as Record<string, unknown>
    const meta = readPlanningMeta(spec)
    const qty = Math.max(1, Math.floor(Number(line.quantity || 1)))
    const ups = Math.max(1, Math.floor(Number(meta.ups || 1)))
    const wastageSheets = Math.max(0, Math.floor(Number(wastageSheetsInput || 0)))
    const requiredSheets = Math.max(1, Math.ceil(qty / ups) + wastageSheets)
    const selectedOption =
      cutsPerSheetArg && parentSizeArg
        ? { cutsPerSheet: cutsPerSheetArg, size: parentSizeArg }
        : getSuggestionOption(chosenMaterialId) ||
          (() => {
            const metaCuts = Number(meta.cutsPerSheet || 0)
            const metaParentSize = typeof meta.parentSize === 'string' ? meta.parentSize.trim() : ''
            if (metaCuts > 0 && metaParentSize) {
              return {
                cutsPerSheet: metaCuts,
                size: metaParentSize,
                requiredParentSheets: Math.max(1, Math.ceil(requiredSheets / metaCuts)),
              }
            }
            return null
          })()
    const selectedCutsPerSheet = Number(selectedOption?.cutsPerSheet || 0)
    const selectedParentSize = String(selectedOption?.size || '').trim()
    const selectedRequiredParentSheets = Math.max(
      0,
      Number((selectedOption as { requiredParentSheets?: number } | null)?.requiredParentSheets || 0) ||
        (selectedCutsPerSheet > 0 ? Math.ceil(requiredSheets / selectedCutsPerSheet) : 0),
    )
    if (!chosenMaterialId) {
      const msg = 'No material selected'
      setReserveInlineError(msg)
      toast.error(msg)
      return
    }
    if (!selectedCutsPerSheet || selectedCutsPerSheet <= 0 || !selectedRequiredParentSheets || selectedRequiredParentSheets <= 0 || !selectedParentSize) {
      const msg = 'Invalid calculation data'
      setReserveInlineError(msg)
      toast.error(msg)
      return
    }
    const selectedMeta = (readiness?.suggestedBoardOptions || readiness?.closestAvailableOptions || []).find((o) => o.materialId === chosenMaterialId)
    const availableSheets = Math.max(0, Number(selectedMeta?.availableSheets ?? readiness?.availableSheets ?? 0))
    const reservedSheets = Math.max(0, Number(selectedMeta?.reservedSheets ?? readiness?.reservedSheets ?? 0))
    const freeSheets = Number(selectedMeta?.freeSheets ?? (availableSheets - reservedSheets))
    const reservable = Math.max(0, freeSheets)
    const reserveQty = Math.min(reservable, selectedRequiredParentSheets)
    const shortageQty = Math.max(0, selectedRequiredParentSheets - reserveQty)
    const materialCode =
      (readiness?.suggestedBoardOptions || readiness?.closestAvailableOptions || []).find((o) => o.materialId === chosenMaterialId)?.materialCode ||
      readiness?.materialCode ||
      chosenMaterialId
    const selectionReason = [
      selectedMeta?.matchRank ? `Rank #${selectedMeta.matchRank}` : null,
      selectedMeta?.tags?.includes('Exact Match') ? 'Exact size + GSM match' : null,
      selectedMeta?.tags?.includes('Compatible Size') ? 'Compatible size fit' : null,
      selectedMeta?.tags?.includes('GSM Tolerance') ? 'Within GSM tolerance' : null,
      selectedMeta?.tags?.includes('Lowest Wastage') ? 'Lowest wastage' : null,
      selectedMeta?.tags?.includes('Most Available') ? 'Best availability' : null,
    ].filter(Boolean).join(' • ')
    const reqPair = parseSizePair(readiness?.requiredFinalSize || '')
    const parentPair = parseSizePair(selectedParentSize)
    const autoLeftoverLength =
      reqPair && parentPair
        ? Math.max(0, Number((parentPair.length - reqPair.length).toFixed(4)))
        : 0
    const autoLeftoverWidth =
      reqPair && parentPair
        ? Math.max(0, Number((parentPair.width - reqPair.width).toFixed(4)))
        : 0
    setReserveConfirm({
      materialId: chosenMaterialId,
      materialCode,
      parentSize: selectedParentSize,
      gsm: Number((readiness?.suggestedBoardOptions || readiness?.closestAvailableOptions || []).find((o) => o.materialId === chosenMaterialId)?.gsm ?? readiness?.gsm ?? null),
      cutsPerSheet: selectedCutsPerSheet,
      calculatedCutsPerSheet: selectedCutsPerSheet,
      selectedCutsPerSheetInput: String(selectedCutsPerSheet),
      requiredParentSheets: selectedRequiredParentSheets,
      availableSheets,
      reservedSheets,
      freeSheets,
      alreadyReservedSheets: Math.max(0, Number(readiness?.reservedSheets || 0)),
      currentShortageSheets: Math.max(0, Number(readiness?.shortageSheets || 0)),
      reserveQtyInput: String(reserveQty),
      reserveQty,
      shortageQty,
      prQtyInput: String(shortageQty),
      prQty: shortageQty,
      leftoverAvailableAfterReserve: Math.max(0, reservable - reserveQty),
      currentReservedForLine: Math.max(0, Number(readiness?.reservedForLine || 0)),
      finalRequiredSheets: requiredSheets,
      isCutsManualOverride: false,
      overrideReason: '',
      selectedReason: selectionReason || 'Top ranked option based on fit and stock',
      leftoverLengthInput: autoLeftoverLength > 0 ? String(autoLeftoverLength) : '',
      leftoverWidthInput: autoLeftoverWidth > 0 ? String(autoLeftoverWidth) : '',
      leftoverQtyInput: '',
      leftoverRemarks: '',
      addLeftoverToWarehouse: false,
      leftoverWeightKg: 0,
      cutSizeUsed: readiness?.requiredFinalSize || '',
    })
    setReservePrEdited(false)
    void loadOptionDetails(chosenMaterialId)
    setReserveConfirmOpen(true)
  }, [line, selectedMaterialId, readiness, wastageSheetsInput, getSuggestionOption, loadOptionDetails])

  const handleReserveMaterial = useCallback(async () => {
    if (!line || !reserveConfirm) return
    setReserveInlineError(null)
    setReserveModalError(null)
    const parsedReserveQty = Number(reserveConfirm.reserveQtyInput)
    if (!Number.isFinite(parsedReserveQty)) {
      setReserveModalError('Reserve Qty must be numeric')
      return
    }
    const safeReserveQty = Math.max(0, parsedReserveQty)
    const requiredParentSheets = Math.max(1, Math.floor(Number(reserveConfirm.requiredParentSheets || 0)))
    const maxReserve = Math.min(Math.max(0, Number(reserveConfirm.freeSheets || 0)), requiredParentSheets)
    if (safeReserveQty > maxReserve) {
      const msg = 'Reserve Qty cannot exceed free stock or required sheets'
      setReserveModalError(msg)
      return
    }
    const safeShortageQty = Math.max(0, requiredParentSheets - safeReserveQty)
    const parsedPrQty = Number(reserveConfirm.prQtyInput)
    if (!Number.isFinite(parsedPrQty)) {
      setReserveModalError('PR Qty must be numeric')
      return
    }
    const safePrQty = Math.max(0, parsedPrQty)
    if (
      !reserveConfirm.isCutsManualOverride &&
      reserveConfirm.cutsPerSheet > reserveConfirm.calculatedCutsPerSheet
    ) {
      setReserveModalError('Cuts per sheet cannot exceed calculated max without manual override')
      return
    }
    if (safeShortageQty > 0 && safePrQty === 0) {
      setReserveModalError('Shortage will remain without PR.')
      return
    }
    setReserveBusy(true)
    const readinessBefore = readiness
    const selectedBefore = selectedMaterialId
    const lockedBefore = selectionLocked
    const optimisticPrStatus = safeShortageQty > 0 ? (safePrQty > 0 ? 'draft' : 'not_created') : (readiness?.prStatus || 'not_created')
    setSelectedMaterialId(reserveConfirm.materialId)
    setSelectionLocked(true)
    setReadiness((prev) =>
      prev
        ? {
            ...prev,
            materialId: reserveConfirm.materialId,
            materialCode: reserveConfirm.materialCode,
            boardType: prev.boardType || null,
            boardClassification: prev.boardClassification || null,
            size: reserveConfirm.parentSize || prev.size,
            requiredSheets: requiredParentSheets,
            availableSheets: Math.max(0, (reserveConfirm.availableSheets || 0) - safeReserveQty),
            reservedSheets: Math.max(0, (reserveConfirm.reservedSheets || 0) + safeReserveQty),
            freeSheets: Math.max(0, (reserveConfirm.freeSheets || 0) - safeReserveQty),
            shortageSheets: safeShortageQty,
            prStatus: optimisticPrStatus,
            reservedForLine: safeReserveQty,
            reservedByMaterial: {
              ...(prev.reservedByMaterial || {}),
              [reserveConfirm.materialId]: safeReserveQty,
            },
            status: safeShortageQty > 0 ? (safeReserveQty > 0 ? 'yellow' : 'red') : 'green',
          }
        : prev,
    )
    try {
      const spec = (line.specOverrides || {}) as Record<string, unknown>
      const meta = readPlanningMeta(spec)
      const wastageSheets = Math.max(0, Math.floor(Number(wastageSheetsInput || 0)))
      const res = await fetch(`/api/planning/po-lines/${line.id}/reserve-material`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'reserve',
          materialId: reserveConfirm.materialId,
          wastageSheets,
          requiredSheets: requiredParentSheets,
          requiredParentSheets,
          reserveQty: safeReserveQty,
          shortageQty: safeShortageQty,
          prQty: safePrQty,
          planningLineId: line.id,
          poLineId: line.id,
          cutsPerSheet: reserveConfirm.calculatedCutsPerSheet || Number(meta.cutsPerSheet || 0),
          selectedCutsPerSheet: reserveConfirm.cutsPerSheet || Number(meta.cutsPerSheet || 0),
          isCutsManualOverride: reserveConfirm.isCutsManualOverride,
          overrideReason: reserveConfirm.overrideReason || null,
          parentSize: reserveConfirm.parentSize || String(meta.parentSize || ''),
          leftover: {
            addToWarehouse: reserveConfirm.addLeftoverToWarehouse,
            leftoverLength: Number(reserveConfirm.leftoverLengthInput || 0),
            leftoverWidth: Number(reserveConfirm.leftoverWidthInput || 0),
            leftoverQty: Number(reserveConfirm.leftoverQtyInput || 0),
            leftoverRemarks: reserveConfirm.leftoverRemarks || '',
            cutSizeUsed: reserveConfirm.cutSizeUsed || '',
          },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const errData = data as {
          error?: string
          message?: string
          errorCode?: string
          retryable?: boolean
          shortageId?: string
          details?: unknown
        }
        if (errData.retryable && errData.shortageId) {
          const retryMsg = errData.message || errData.error || 'Reservation completed, but PR creation failed.'
          setReserveInlineError(retryMsg)
          setReserveModalError(retryMsg)
          toast.error(retryMsg, {
            action: {
              label: 'Create PR for Shortage',
              onClick: async () => {
                const retry = await fetch(`/api/material-shortages/${errData.shortageId}/create-pr`, { method: 'POST' })
                const retryData = await retry.json().catch(() => ({}))
                if (!retry.ok) {
                  toast.error((retryData as { error?: string }).error || 'Retry failed')
                  return
                }
                toast.success('Purchase Request created for shortage.')
                window.dispatchEvent(new Event('planning:refresh'))
                window.dispatchEvent(new Event('inventory:refresh'))
              },
            },
          })
          return
        }
        const backendMessage = errData.message || errData.error || 'Reservation failed'
        setReserveInlineError(backendMessage)
        setReserveModalError(backendMessage)
        throw new Error(backendMessage)
      }
      const out = data as { status: string; reservedSheets: number; shortageSheets: number; purchaseRequestId?: string | null }
      setReserveInlineError(null)
      setReserveModalError(null)
      const msg = `Reserved ${out.reservedSheets.toLocaleString('en-IN')} sheets. PR created for ${Math.max(0, out.shortageSheets).toLocaleString('en-IN')} sheets.`
      toast.success(msg)
      setUndoState({
        materialId: reserveConfirm.materialId,
        requiredSheets: requiredParentSheets,
        targetReserveQty: reserveConfirm.currentReservedForLine,
        prQty: Math.max(0, requiredParentSheets - reserveConfirm.currentReservedForLine),
        label: 'Undo last reserve',
      })
      await loadReadiness()
      window.dispatchEvent(new Event('planning:refresh'))
      window.dispatchEvent(new Event('inventory:refresh'))
      setReserveConfirmOpen(false)
    } catch (e) {
      const errMessage = e instanceof Error ? e.message : 'Reservation failed'
      setReadiness(readinessBefore)
      setSelectedMaterialId(selectedBefore)
      setSelectionLocked(lockedBefore)
      setReserveInlineError(errMessage)
      setReserveModalError(errMessage)
      toast.error(errMessage)
    } finally {
      setReserveBusy(false)
    }
  }, [line, reserveConfirm, loadReadiness, readiness, selectedMaterialId, selectionLocked, wastageSheetsInput])

  const openReservationControl = useCallback(async (mode: ReservationControlMode, preferredMaterialId?: string) => {
    if (!line) return
    const materialId = preferredMaterialId || selectedMaterialId || readiness?.materialId || ''
    if (!materialId) {
      toast.error('No material selected')
      return
    }
    setReservationControlError(null)
    try {
      const spec = (line.specOverrides || {}) as Record<string, unknown>
      const meta = readPlanningMeta(spec)
      const qty = Math.max(1, Math.floor(Number(line.quantity || 1)))
      const ups = Math.max(1, Math.floor(Number(meta.ups || 1)))
      const wastageSheets = Math.max(0, Math.floor(Number(wastageSheetsInput || 0)))
      const requiredSheets = Math.max(0, Number(readiness?.requiredSheets || Math.ceil(qty / ups) + wastageSheets))
      const params = new URLSearchParams({
        materialId,
        requiredSheets: String(requiredSheets),
      })
      const res = await fetch(`/api/planning/po-lines/${line.id}/reservation-control?${params.toString()}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { message?: string }).message || 'Failed to load reservation snapshot')
      const snap = data as {
        materialCode: string
        requiredSheets: number
        availableSheets: number
        reservedSheets: number
        reservedForLine: number
        shortageSheets: number
        prId: string | null
        prStatus: string
        prQty: number
        jobCard?: { status?: string | null } | null
      }
      const reserveQtyDefault = Math.min(Math.max(0, Number(snap.availableSheets || 0) + Number(snap.reservedForLine || 0)), Math.max(0, Number(snap.requiredSheets || 0)))
      const shortageDefault = Math.max(0, Number(snap.requiredSheets || 0) - reserveQtyDefault)
      const releaseQtyDefault = Math.max(0, Number(snap.reservedForLine || 0))
      setReservationControl({
        mode,
        materialId,
        materialCode: snap.materialCode || materialId,
        requiredSheets: Math.max(0, Number(snap.requiredSheets || 0)),
        availableSheets: Math.max(0, Number(snap.availableSheets || 0)),
        reservedSheetsTotal: Math.max(0, Number(snap.reservedSheets || 0)),
        currentReservedForLine: Math.max(0, Number(snap.reservedForLine || 0)),
        currentShortageSheets: Math.max(0, Number(snap.shortageSheets || 0)),
        prId: typeof snap.prId === 'string' ? snap.prId : null,
        prStatus: typeof snap.prStatus === 'string' ? snap.prStatus : 'not_created',
        prQtyCurrent: Math.max(0, Number(snap.prQty || 0)),
        reserveQtyInput: String(reserveQtyDefault),
        reserveQty: reserveQtyDefault,
        releaseQtyInput: String(releaseQtyDefault),
        releaseQty: releaseQtyDefault,
        prQtyInput: String(mode === 'generate_pr' ? Math.max(0, Number(snap.shortageSheets || 0)) : shortageDefault),
        prQty: mode === 'generate_pr' ? Math.max(0, Number(snap.shortageSheets || 0)) : shortageDefault,
        shortageQty: shortageDefault,
        leftoverAvailableAfterReserve: Math.max(0, Number(snap.availableSheets || 0) + Number(snap.reservedForLine || 0) - reserveQtyDefault),
        prImpactAction: 'reduce',
        warningMessage: null,
        jobCardStatus: typeof snap.jobCard?.status === 'string' ? snap.jobCard.status : null,
      })
      setReservationControlOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to open reservation control')
    }
  }, [line, selectedMaterialId, readiness?.materialId, readiness?.requiredSheets, wastageSheetsInput])

  const updateReservationControlDerived = useCallback((draft: ReservationControlDraft) => {
    if (draft.mode === 'release') {
      const parsedRelease = Number(draft.releaseQtyInput)
      const safeRelease = Number.isFinite(parsedRelease) ? Math.max(0, parsedRelease) : 0
      const cappedRelease = Math.min(safeRelease, draft.currentReservedForLine)
      const newReservedForLine = Math.max(0, draft.currentReservedForLine - cappedRelease)
      const shortageQty = Math.max(0, draft.requiredSheets - newReservedForLine)
      return {
        ...draft,
        releaseQty: cappedRelease,
        shortageQty,
        leftoverAvailableAfterReserve: Math.max(0, draft.availableSheets + cappedRelease),
        warningMessage:
          draft.prQty < shortageQty ? 'PR Qty is less than shortage. Remaining shortage will stay open.' : null,
      }
    }
    const parsedReserve = Number(draft.reserveQtyInput)
    const safeReserve = Number.isFinite(parsedReserve) ? Math.max(0, parsedReserve) : 0
    const cap = Math.min(draft.requiredSheets, draft.availableSheets + draft.currentReservedForLine)
    const reserveQty = Math.min(safeReserve, cap)
    const shortageQty = Math.max(0, draft.requiredSheets - reserveQty)
    return {
      ...draft,
      reserveQty,
      shortageQty,
      leftoverAvailableAfterReserve: Math.max(0, draft.availableSheets + draft.currentReservedForLine - reserveQty),
      warningMessage:
        draft.prQty < shortageQty ? 'PR Qty is less than shortage. Remaining shortage will stay open.' : null,
    }
  }, [])

  const submitReservationControl = useCallback(async () => {
    if (!line || !reservationControl) return
    setReservationControlError(null)
    setReservationControlBusy(true)
    const readinessBefore = readiness
    try {
      const mode = reservationControl.mode
      const body: Record<string, unknown> = {
        materialId: reservationControl.materialId,
        requiredSheets: reservationControl.requiredSheets,
      }
      if (mode === 'adjust') {
        body.action = 'adjust'
        body.targetReserveQty = reservationControl.reserveQty
        body.prQty = reservationControl.prQty
      } else if (mode === 'release') {
        body.action = 'release'
        body.releaseQty = reservationControl.releaseQty
        body.prImpactAction = reservationControl.prImpactAction
      } else {
        body.action = 'generate_pr'
        body.prQty = reservationControl.prQty
        body.reservedSheets = reservationControl.currentReservedForLine
      }
      const res = await fetch(`/api/planning/po-lines/${line.id}/reservation-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((out as { message?: string }).message || 'Action failed')
      if (mode === 'adjust' || mode === 'release') {
        setUndoState({
          materialId: reservationControl.materialId,
          requiredSheets: reservationControl.requiredSheets,
          targetReserveQty: reservationControl.currentReservedForLine,
          prQty: Math.max(0, reservationControl.requiredSheets - reservationControl.currentReservedForLine),
          label: mode === 'adjust' ? 'Undo last adjustment' : 'Undo last release',
        })
      }
      await loadReadiness()
      window.dispatchEvent(new Event('planning:refresh'))
      window.dispatchEvent(new Event('inventory:refresh'))
      setReservationControlOpen(false)
      toast.success(
        mode === 'generate_pr'
          ? 'Purchase Request generated.'
          : mode === 'release'
            ? 'Reservation released successfully.'
            : 'Reservation adjusted successfully.',
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Action failed'
      setReadiness(readinessBefore)
      console.error('[planning-reservation-control]', {
        mode: reservationControl.mode,
        planningId: line.id,
        materialId: reservationControl.materialId,
        error: msg,
      })
      setReservationControlError(msg)
      toast.error(msg)
    } finally {
      setReservationControlBusy(false)
    }
  }, [line, reservationControl, loadReadiness, readiness])

  const applyUndoReservation = useCallback(async () => {
    if (!line || !undoState) return
    try {
      const res = await fetch(`/api/planning/po-lines/${line.id}/reservation-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adjust',
          materialId: undoState.materialId,
          requiredSheets: undoState.requiredSheets,
          targetReserveQty: undoState.targetReserveQty,
          prQty: undoState.prQty,
        }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((out as { message?: string }).message || 'Undo failed')
      await loadReadiness()
      window.dispatchEvent(new Event('planning:refresh'))
      window.dispatchEvent(new Event('inventory:refresh'))
      setUndoState(null)
      toast.success('Undo applied')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Undo failed')
    }
  }, [line, loadReadiness, undoState])

  const applyBestSuggestion = useCallback(() => {
    const best = mainSuggestionOptions[0]
    if (!best) {
      toast.error('No suggestions available')
      return
    }
    openReserveConfirmation(best.materialId, best.cutsPerSheet, best.size)
  }, [mainSuggestionOptions, openReserveConfirmation])

  const handleAddToBatch = useCallback(() => {
    if (!line) return
    setPlanningSelection((prev) => {
      const next = new Set(prev)
      next.add(line.id)
      return next
    })
    toast.info('Line added to selection. Select more lines, then click Open Group Builder.', { duration: 4000 })
  }, [line, setPlanningSelection])

  const handlePriority = useCallback(async () => {
    if (!line) return
    setActionBusy(true)
    try {
      const next = line.directorPriority !== true
      const res = await fetch(`/api/director-command-center/lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directorPriority: next }),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(j.error || 'Update failed')
      updateRow(line.id, { directorPriority: next })
      broadcastIndustrialPriorityChange({ source: 'line_director_priority', at: new Date().toISOString() })
      toast.success(next ? 'Line marked priority' : 'Priority cleared for line')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setActionBusy(false)
    }
  }, [line, updateRow])

  const handleHold = useCallback(async () => {
    if (!line) return
    setActionBusy(true)
    try {
      const next = line.directorHold !== true
      const res = await fetch(`/api/planning/po-lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directorHold: next, planningDecisionRevision: true }),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(j.error || 'Update failed')
      updateRow(line.id, { directorHold: next })
      toast.success(next ? 'Job on hold' : 'Hold released')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setActionBusy(false)
    }
  }, [line, updateRow])

  const saveToProductMaster = useCallback(async () => {
    if (!line?.cartonId) {
      toast.error('No product (carton) linked to this line')
      return
    }
    setSaveMasterBusy(true)
    try {
      const spec = (line.specOverrides || {}) as Record<string, unknown>
      const meta = readPlanningMeta(spec)
      const ups =
        typeof meta.ups === 'number' && Number.isFinite(meta.ups) && meta.ups >= 1
          ? Math.floor(meta.ups)
          : null
      const numberOfColours =
        typeof spec.numberOfColours === 'number' && Number.isFinite(spec.numberOfColours)
          ? Math.floor(spec.numberOfColours)
          : line.carton?.numberOfColours ?? null
      let mergedSpecialInstructions: Record<string, unknown> = {
        notes: '',
        brailleEnabled: false,
        leafingEnabled: false,
        embossingEnabled: false,
        spotUvEnabled: false,
      }
      if (typeof line.carton?.specialInstructions === 'string' && line.carton.specialInstructions.trim()) {
        try {
          const parsed = JSON.parse(line.carton.specialInstructions) as Record<string, unknown>
          mergedSpecialInstructions = { ...mergedSpecialInstructions, ...parsed }
        } catch {}
      }
      mergedSpecialInstructions.ups = ups
      const res = await fetch(`/api/masters/cartons/${line.cartonId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardGrade: typeof spec.boardGrade === 'string' ? spec.boardGrade : undefined,
          gsm: line.gsm ?? line.carton?.gsm ?? undefined,
          paperType: line.paperType ?? line.carton?.paperType,
          coatingType: line.coatingType ?? line.carton?.coatingType,
          laminateType: line.otherCoating ?? line.carton?.laminateType,
          embossingLeafing: line.embossingLeafing,
          pastingType: specPasting(line) || undefined,
          blankLength: sheetLengthMm.trim() ? Number(sheetLengthMm.trim()) : undefined,
          blankWidth: sheetWidthMm.trim() ? Number(sheetWidthMm.trim()) : undefined,
          numberOfColours: numberOfColours ?? undefined,
          specialInstructions: JSON.stringify(mergedSpecialInstructions),
        }),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.status === 403) {
        toast.error('Requires Operations Head or MD to update the product master')
        return
      }
      if (!res.ok) throw new Error(j.error || 'Could not update master')
      toast.success('Product master updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaveMasterBusy(false)
    }
  }, [line, sheetLengthMm, sheetWidthMm])

  // ── Stable Planning-Engine callbacks ─────────────────────────────────────
  // Wrapped in useCallback so React.memo on child sections is effective —
  // anonymous inline functions create new references on every render.
  // Must live before the `if (!line || !open) return null` early return to
  // satisfy react-hooks/rules-of-hooks.

  /** Optimistically reflect spec edits in the grid row, then persist. */
  const handleEnginePatch = useCallback(
    async (patch: PlanningLineFieldPatch) => {
      if (!line) return false
      updateRow(line.id, patch as Partial<PlanningGridLine>)
      return onSaveLine(line.id, patch)
    },
    [line, updateRow, onSaveLine],
  )

  /** Link a board material — saves to specOverrides and reloads readiness. */
  const handleEngineSelectBoard = useCallback(
    async (materialId: string) => {
      await lockSelectionOnly(materialId)
    },
    [lockSelectionOnly],
  )

  /**
   * Persist board-allocation sheet size / UPS back onto the linked carton
   * (product) master so it auto-populates next time. Values are inches.
   * Silently no-ops when no carton is linked (the line-level spec patch already
   * captured the value); surfaces a toast only for permission/server errors.
   */
  const handleEngineSaveCartonMaster = useCallback(
    async (patch: { sheetSizeL?: number | null; sheetSizeW?: number | null; ups?: number | null }) => {
      if (!line?.cartonId) return
      try {
        const res = await fetch(`/api/masters/cartons/${line.cartonId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (res.status === 403) {
          toast.error('Requires Operations Head or MD to update the product master')
          return
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(j.error || 'Could not update product master')
        }
        updateRow(line.id, { carton: { ...(line.carton ?? {}), ...patch } })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to update product master')
      }
    },
    [line, updateRow],
  )

  /**
   * Lock the batch decision and propagate it downstream (req-12):
   *  1. Persist the spec/remarks via onSave.
   *  2. Stamp a lock marker (planningCore.lockedAt + status='Locked') into
   *     specOverrides so the engine adapter renders the line as Locked.
   *  3. Best-effort push to the Artwork Queue via make-processing
   *     (sets planningStatus='design_ready'). A failure here warns but does
   *     NOT throw — the lock itself already succeeded.
   *  4. Refresh readiness + broadcast a planning refresh.
   */
  const handleEngineLock = useCallback(async () => {
    if (!line) return
    try {
      // 1 — persist current spec/remarks
      await onSave(line.id)

      // 2 — stamp the lock marker into planningCore (mirrors patchPlanningCore
      //     in SectionBatchDecision: { ...spec, planningCore: { ...pc, ... } }).
      const baseSpec = { ...((line.specOverrides ?? {}) as Record<string, unknown>) }
      const pc = {
        ...(typeof baseSpec.planningCore === 'object' && baseSpec.planningCore
          ? (baseSpec.planningCore as Record<string, unknown>)
          : {}),
      }
      pc.lockedAt = new Date().toISOString()
      pc.status = 'Locked'
      const nextSpec = { ...baseSpec, planningCore: pc }
      updateRow(line.id, { specOverrides: nextSpec })
      await onSaveLine(line.id, { specOverrides: nextSpec })

      // 3 — best-effort push to Artwork Queue
      try {
        const res = await fetch('/api/planning/po-lines/make-processing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lineIds: [line.id] }),
        })
        const j = (await res.json().catch(() => ({}))) as {
          error?: string
          warnings?: { field: string; values: string[] }[]
        }
        if (!res.ok) {
          toast.warning(`Locked, but Artwork Queue push failed: ${j.error ?? 'unknown error'}`)
        } else if (j.warnings && j.warnings.length > 0) {
          toast.success(`Locked & sent to Artwork Queue — warnings: ${j.warnings.map((w) => w.field).join(', ')}`)
        } else {
          toast.success('Locked & sent to Artwork Queue')
        }
      } catch {
        toast.warning('Locked, but Artwork Queue push failed (network error)')
      }

      // 4 — refresh
      await loadReadiness()
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to lock')
    }
  }, [line, onSave, onSaveLine, updateRow, loadReadiness])

  /**
   * Generate a Job Card from the locked planning decision (req-12).
   * Only ever called from the explicit "Generate job card" button — the route
   * has heavy side effects (stages, tooling custody, material reserve) and must
   * never run automatically. The route fills its own defaults from an empty body.
   */
  const handleGenerateJobCard = useCallback(async () => {
    if (!line) return
    try {
      const res = await fetch(`/api/planning/po-lines/${line.id}/generate-job-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
      if (!res.ok) {
        throw new Error(data.error || data.message || 'Failed to generate job card')
      }
      toast.success('Job card generated')
      await loadReadiness()
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to generate job card')
    }
  }, [line, loadReadiness])

  /**
   * Reserve the matched material against this line's requirement.
   * Opens the existing confirmation modal so the planner can verify
   * sheets, cuts, leftover, and PR quantity before committing.
   * Button is shown only when shortage === 0 (stock covers requirement).
   */
  const handleEngineReserve = useCallback(async () => {
    openReserveConfirmation()
  }, [openReserveConfirmation])

  /**
   * Raise a Purchase Request for the open shortage on this line.
   * If a shortageId is already present on readiness, use it directly.
   * If there is a shortage (shortageSheets > 0) but no shortageId yet,
   * call the ensure_shortage branch of the reserve-material route to
   * create the shortage record first, then raise the PR from it.
   * This makes Raise PR self-sufficient — no prior Reserve step needed.
   */
  const handleEngineRaisePR = useCallback(async () => {
    let sid = readiness?.shortageId ?? null
    const shortageSheets = Math.max(0, Number(readiness?.shortageSheets ?? 0))
    const materialId = readiness?.materialId ?? null

    if (!sid && shortageSheets > 0 && line && materialId) {
      try {
        const ensureRes = await fetch(`/api/planning/po-lines/${line.id}/reserve-material`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actionType: 'ensure_shortage',
            materialId,
            requiredSheets: Math.max(1, Math.floor(Number(readiness?.requiredSheets ?? shortageSheets))),
          }),
        })
        const ensureData = await ensureRes.json().catch(() => ({}))
        if (!ensureRes.ok) {
          throw new Error((ensureData as { message?: string; error?: string }).message || (ensureData as { error?: string }).error || 'Failed to create shortage record')
        }
        sid = (ensureData as { shortageId?: string | null }).shortageId ?? null
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to create shortage record')
        return
      }
    }

    if (!sid) {
      toast.error('No shortage record found. Reserve material first to generate a PR.')
      return
    }
    try {
      const res = await fetch(`/api/material-shortages/${sid}/create-pr`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to create PR')
      toast.success('Purchase Request created for shortage.')
      await loadReadiness()
      window.dispatchEvent(new Event('planning:refresh'))
      window.dispatchEvent(new Event('inventory:refresh'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create PR')
    }
  }, [readiness?.shortageId, readiness?.shortageSheets, readiness?.materialId, readiness?.requiredSheets, line, loadReadiness])

  const handleEngineUnreserve = useCallback(async () => {
    if (!line) return
    const materialId = readiness?.materialId
    if (!materialId) {
      toast.error('No material selected. Cannot unreserve.')
      return
    }
    const reservedSheets = Math.max(0, Number(readiness?.reservedSheets ?? 0))
    if (reservedSheets <= 0) {
      toast.error('No reserved stock to release.')
      return
    }
    try {
      const res = await fetch(`/api/planning/po-lines/${line.id}/reservation-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'release',
          materialId,
          requiredSheets: Math.max(0, Math.floor(Number(readiness?.requiredSheets ?? 0))),
          releaseQty: reservedSheets,
          prImpactAction: 'reduce',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { message?: string }).message || 'Failed to unreserve')
      toast.success('Reservation released.')
      await loadReadiness()
      window.dispatchEvent(new Event('planning:refresh'))
      window.dispatchEvent(new Event('inventory:refresh'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to unreserve')
    }
  }, [line, readiness?.materialId, readiness?.reservedSheets, readiness?.requiredSheets, loadReadiness])

  if (!line || !open) return null

  const spec = (line.specOverrides || {}) as Record<string, unknown>
  const renderUpsField = true
  const meta = readPlanningMeta(spec)
  const resolvedUps = resolveUps({
    ...line,
    specOverrides: spec,
    spec,
    carton: (line.carton || {}) as Record<string, unknown>,
  })
  const gangUpsStr =
    renderUpsField && resolvedUps != null
      ? String(Math.floor(Number(resolvedUps)))
      : ''
  const boardInput = String(spec.boardGrade || line.materialQueue?.boardType || '').trim()
  const resolvedSheetSize = resolveSheetSize({
    specOverrides: spec,
    product: (line.carton || {}) as Record<string, unknown>,
    carton: (line.carton || {}) as Record<string, unknown>,
    materialQueue: (line.materialQueue || {}) as Record<string, unknown>,
  })
  const amount = (line.quantity || 0) * (line.rate != null ? Number(line.rate) : 0)
  const calcQty = Math.max(1, Number(line.quantity || 1))
  const calcUps = Math.max(1, Number(gangUpsStr || 1))
  const calcWastageSheets = Math.max(0, Math.floor(Number(wastageSheetsInput || 0)))
  const calcBaseSheets = Math.max(1, Math.ceil(calcQty / calcUps))
  const calcRequiredSheets = Math.max(1, calcBaseSheets + calcWastageSheets)

  const totalQty = line.quantity
  const splitB = typeof splitA === 'number' && splitA > 0 && splitA < totalQty ? totalQty - splitA : null

  const fieldInput = 'ds-input mt-0.5 w-full text-sm py-2 [color-scheme:dark]'
  const comboControl = 'border-ds-line/80 bg-ds-elevated/50'
  const comboInput = 'text-sm text-ds-ink'
  const noMaterialSelected = !readinessLoading && !(selectedMaterialId || readiness?.materialId)
  const mappingLabel =
    readiness?.mappingSafety?.strategyUsed === 'strict'
      ? 'Strict match'
      : readiness?.mappingSafety?.strategyUsed === 'fallback_without_classification'
        ? 'Without classification match'
        : readiness?.mappingSafety?.strategyUsed === 'fallback_wider_gsm_tolerance'
          ? 'GSM tolerance match'
          : readiness?.mappingSafety?.strategyUsed === 'closest_only'
            ? 'Closest available option'
            : '-'
  const statusTone =
    readiness?.status === 'green'
      ? 'border-ds-success/35 bg-ds-success/10 text-ds-success'
      : readiness?.status === 'yellow'
        ? 'border-ds-warning/35 bg-ds-warning/10 text-ds-warning'
        : readiness?.status === 'red'
          ? 'border-ds-danger/35 bg-ds-danger/10 text-ds-danger'
          : 'border-ds-line/60 bg-ds-elevated/40 text-ds-ink-muted'
  const materialSummary = readiness
    ? readiness.status === 'green'
      ? `Required ${Math.max(0, readiness.requiredSheets).toLocaleString('en-IN')} sheets. ${Math.max(0, readiness.availableSheets).toLocaleString('en-IN')} available. Ready to reserve.`
      : readiness.status === 'yellow'
        ? `Required ${Math.max(0, readiness.requiredSheets).toLocaleString('en-IN')} sheets. ${Math.max(0, readiness.availableSheets).toLocaleString('en-IN')} available. Shortage ${Math.max(0, readiness.shortageSheets).toLocaleString('en-IN')}.`
        : readiness.status === 'red'
          ? `Required ${Math.max(0, readiness.requiredSheets).toLocaleString('en-IN')} sheets. No stock available. Shortage ${Math.max(0, readiness.shortageSheets).toLocaleString('en-IN')}.`
          : 'No matching material selected.'
    : 'No material selected.'
  const readinessAction = (() => {
    if (!readiness || noMaterialSelected) return 'Select material'
    if (readiness.status === 'green') return 'Ready for Artwork'
    if (readiness.status === 'yellow') return 'Shortage PR created / pending'
    if (readiness.status === 'red') return 'Create PR required'
    return 'Select material'
  })()
  const hasDecisionInputs =
    !!resolvedSheetSize && resolvedSheetSize !== '-' &&
    calcQty > 0 &&
    calcUps > 0
  const strictSuggestionCount = readiness?.suggestedBoardOptions?.length || 0
  const compatibleSuggestionCount = readiness?.closestAvailableOptions?.length || 0
  const visibleSuggestionCount = strictSuggestionCount > 0 ? strictSuggestionCount : compatibleSuggestionCount

  return (
    <PlanningEngineModal
      isOpen={open}
      onClose={onClose}
      zIndexClass="z-[200]"
      widthClass="max-w-[1180px]"
      title={<span className="truncate" title={line.cartonName}>{line.cartonName}</span>}
      metadata={
        <div className="flex flex-wrap items-center gap-2 mt-0.5">
          <span className="font-id-mono text-xs text-ds-warning">{line.po.poNumber}</span>
          <span className="text-ds-line/60">·</span>
          <span className="text-xs text-ds-ink-faint">{line.planningStatus}</span>
          <span className="text-ds-line/60">·</span>
          <span className="text-xs text-ds-ink-faint truncate max-w-[18rem]">{line.po.customer.name}</span>
          {line.po.isPriority ? (
            <Badge
              tone="warning"
              className={`inline-flex items-center gap-0.5 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`}
            >
              <Star className="h-3 w-3 fill-current" aria-hidden />
              PO Priority
            </Badge>
          ) : null}
          {line.directorPriority ? <Badge tone="brand" className="text-xs">Line priority</Badge> : null}
          {line.directorHold ? <Badge tone="warning" className="text-xs">On hold</Badge> : null}
          {line.cartonId && onViewProductDetail ? (
            <button
              type="button"
              onClick={onViewProductDetail}
              className="text-xs font-medium text-ds-brand underline-offset-2 transition duration-200 hover:underline"
            >
              Product sheet
            </button>
          ) : null}
        </div>
      }
      statusBar={
        <div className="flex items-center gap-3 text-xs">
          <span className={`inline-flex items-center gap-1.5 rounded-ds-sm border px-2.5 py-1 font-medium ${statusTone}`}>
            {readinessLoading
              ? 'Checking material…'
              : readiness?.status === 'green'
                ? '● Stock ready'
                : readiness?.status === 'yellow'
                  ? '◐ Partial — PR pending'
                  : readiness?.status === 'red'
                    ? '○ Shortage'
                    : '— No material linked'}
          </span>
          {readiness && !readinessLoading ? (
            <span className="text-ds-ink-faint truncate">{materialSummary}</span>
          ) : null}
          {visibleSuggestionCount > 0 && (
            <span className="ml-auto shrink-0 rounded-ds-sm border border-ds-brand/40 bg-ds-brand/10 px-2 py-0.5 text-ds-brand font-medium">
              {visibleSuggestionCount} board option{visibleSuggestionCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
      }
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
      primaryAction={{
        label: 'Save',
        loadingLabel: 'Saving…',
        onClick: () => { void handleSave() },
        disabled: saving,
        loading: saving,
      }}
    >
      {/* Centred Planning engine body — the canonical drawer UI.
          (The legacy `{false &&}`-gated body was removed in req-13.) */}
      <PlanningEngineBody
        line={engineLine ?? (line as unknown as PlanningEngineLine)}
        readiness={readiness as unknown as PlanningEngineReadiness | null}
        readinessLoading={readinessLoading}
        onPatch={handleEnginePatch}
        onSelectBoard={handleEngineSelectBoard}
        onSaveCartonMaster={handleEngineSaveCartonMaster}
        onLock={handleEngineLock}
        onGenerateJobCard={handleGenerateJobCard}
        onReserve={handleEngineReserve}
        onUnreserve={handleEngineUnreserve}
        onRaisePR={handleEngineRaisePR}
        onOpenWarehouse={() => setWarehousePopupOpen(true)}
      />
      <WarehousePopup
        open={warehousePopupOpen}
        onClose={() => setWarehousePopupOpen(false)}
        lineBoardType={readiness?.boardType ?? line.paperType ?? null}
        lineGsm={readiness?.gsm ?? line.gsm ?? null}
        readiness={readiness as unknown as PlanningEngineReadiness | null}
      />
      <PlanningEngineModal
        isOpen={suggestionsWorkspaceOpen}
        onClose={() => setSuggestionsWorkspaceOpen(false)}
        zIndexClass="z-[80]"
        widthClass="max-w-[1100px]"
        title="Suggestion Workspace"
        metadata={<p className="text-xs text-ds-ink-faint mt-0.5">Extended view for material decision and safer mapping verification.</p>}
        secondaryAction={{
          label: 'Close',
          onClick: () => setSuggestionsWorkspaceOpen(false),
        }}
      >
        <div className="space-y-3 text-xs text-ds-ink">
          <div className="rounded border border-ds-line/40 bg-ds-elevated/20 p-2">
            <p>
              Required size: <span className={mono}>{resolvedSheetSize || '-'}</span> · Qty/UPS: <span className={mono}>{calcQty}/{calcUps}</span> · Required sheets: <span className={mono}>{calcRequiredSheets}</span>
            </p>
            <p className="mt-1 text-ds-ink-faint">
              Strategy: {readiness?.mappingSafety?.strategyUsed || '-'} | Requested board type: {readiness?.mappingSafety?.requestedBoardType || '-'}
            </p>
          </div>
          <div className="overflow-x-auto rounded border border-ds-line/40">
            <table className="w-full min-w-[1080px] table-auto text-left">
              <thead className="bg-ds-elevated/30 text-[11px] uppercase tracking-wide text-ds-ink-faint">
                <tr>
                  <th className="px-2 py-2">
                    <button type="button" className="hover:underline" onClick={() => toggleWorkspaceSort('fit')}>
                      Fit Score
                    </button>
                  </th>
                  <th className="px-2 py-2">Material</th>
                  <th className="px-2 py-2">Parent Size</th>
                  <th className="px-2 py-2">
                    <button type="button" className="hover:underline" onClick={() => toggleWorkspaceSort('gsm')}>
                      GSM
                    </button>
                  </th>
                  <th className="px-2 py-2">
                    <button type="button" className="hover:underline" onClick={() => toggleWorkspaceSort('cuts')}>
                      Cuts
                    </button>
                  </th>
                  <th className="px-2 py-2">
                    <button type="button" className="hover:underline" onClick={() => toggleWorkspaceSort('required')}>
                      Req Parent
                    </button>
                  </th>
                  <th className="px-2 py-2">
                    <button type="button" className="hover:underline" onClick={() => toggleWorkspaceSort('free')}>
                      Avail / Res / Free
                    </button>
                  </th>
                  <th className="px-2 py-2">
                    <button type="button" className="hover:underline" onClick={() => toggleWorkspaceSort('wastage')}>
                      Yield/Waste
                    </button>
                  </th>
                  <th className="px-2 py-2">
                    <button type="button" className="hover:underline" onClick={() => toggleWorkspaceSort('sizeDeviation')}>
                      Size Dev %
                    </button>
                  </th>
                  <th className="px-2 py-2">
                    <button type="button" className="hover:underline" onClick={() => toggleWorkspaceSort('gsmDelta')}>
                      GSM Δ
                    </button>
                  </th>
                  <th className="px-2 py-2">
                    <button type="button" className="hover:underline" onClick={() => toggleWorkspaceSort('leftover')}>
                      Leftover
                    </button>
                  </th>
                  <th className="px-2 py-2">Match</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {workspaceSuggestionOptions.map((opt) => {
                  const openOpt = !!optionDetailsOpen[opt.materialId]
                  const optDetails = optionDetailsByMaterial[opt.materialId]
                  const optLoading = !!optionDetailsLoading[opt.materialId]
                  return (
                  <Fragment key={`ws-${opt.materialId}`}>
                  <tr className="border-t border-ds-line/30">
                    <td className={`px-2 py-2 ${mono}`}>{Number(opt.fitScore ?? 0).toFixed(1)}%</td>
                    <td className="px-2 py-2">
                      <p className={mono}>{opt.materialCode}</p>
                      <p className="text-ds-ink-faint">{opt.boardType || '-'} / {opt.boardClassification || '-'}</p>
                      {opt.sourceTraceability ? (
                        <p className="text-[10px] text-ds-ink-faint">{opt.sourceTraceability}</p>
                      ) : null}
                    </td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.size}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.gsm ?? '-'}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.cutsPerSheet}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.requiredParentSheets}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.availableSheets} / {opt.reservedSheets} / {opt.freeSheets}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.yieldPct}% / {opt.wastagePct}%</td>
                    <td className={`px-2 py-2 ${mono}`}>{Number(opt.sizeDeviationPct ?? 0).toFixed(2)}%</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.gsmDelta == null ? '-' : opt.gsmDelta}</td>
                    <td className="px-2 py-2">{opt.isLeftover ? 'Leftover Reuse' : '-'}</td>
                    <td className="px-2 py-2">
                      <span>{opt.matchType}</span>
                      <span className="ml-1 text-ds-ink-faint">({opt.boardMatchMode === 'exact' ? 'Board exact' : opt.boardMatchMode === 'cross_field' ? 'Board mapped' : 'Board fallback'})</span>
                    </td>
                    <td className="px-2 py-2">{opt.status}</td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          disabled={reserveBusy || Math.max(0, Number(readiness?.reservedByMaterial?.[opt.materialId] || 0)) > 0}
                          onClick={() => openReserveConfirmation(opt.materialId, opt.cutsPerSheet, opt.size)}
                          className="h-7 px-2 text-xs"
                        >
                          {reserveBusy && selectedMaterialId === opt.materialId ? 'Reserving…' : 'Select & Reserve'}
                        </Button>
                        {Math.max(0, Number(readiness?.reservedByMaterial?.[opt.materialId] || 0)) > 0 ? (
                          <>
                            <span className="rounded border border-ds-success/40 bg-ds-success/10 px-2 py-1 text-[11px] text-ds-success">
                              Reserved
                            </span>
                            <button
                              type="button"
                              onClick={() => void openReservationControl('adjust', opt.materialId)}
                              className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
                            >
                              Adjust Reservation
                            </button>
                            <button
                              type="button"
                              onClick={() => void openReservationControl('release', opt.materialId)}
                              className="rounded border border-ds-warning/40 px-2 py-1 text-xs text-ds-warning hover:bg-ds-warning/10"
                            >
                              Release / Unreserve
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={reserveBusy}
                            onClick={() => void lockSelectionOnly(opt.materialId, opt.cutsPerSheet, opt.size)}
                            className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40 disabled:opacity-40"
                          >
                            Lock Only
                          </button>
                        )}
                        <button
                          type="button"
                          className="text-xs font-medium text-ds-brand underline-offset-2 hover:underline"
                          onClick={() => {
                            const next = !openOpt
                            setOptionDetailsOpen((prev) => ({ ...prev, [opt.materialId]: next }))
                            if (next && !optionDetailsByMaterial[opt.materialId]) {
                              void loadOptionDetails(opt.materialId)
                            }
                          }}
                        >
                          {openOpt ? 'Hide Details' : 'View Details'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {openOpt ? (
                    <tr className="border-t border-ds-line/20 bg-ds-elevated/20">
                      <td className="px-2 py-2 text-xs text-ds-ink-faint" colSpan={14}>
                        {optLoading ? (
                          <p>Loading…</p>
                        ) : !optDetails ? (
                          <p>-</p>
                        ) : (
                          <div className="grid grid-cols-2 gap-1">
                            <span>Available: {Math.max(0, readiness?.availableSheets || 0).toLocaleString('en-IN')}</span>
                            <span>Reserved: {Math.max(0, readiness?.reservedSheets || 0).toLocaleString('en-IN')}</span>
                            <span>Incoming: {Math.max(0, readiness?.incomingSheets || 0).toLocaleString('en-IN')}</span>
                            <span>Shortage: {Math.max(0, readiness?.shortageSheets || 0).toLocaleString('en-IN')}</span>
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                )})}
              </tbody>
            </table>
          </div>
        </div>
      </PlanningEngineModal>
      {reserveConfirmOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-3xl overflow-hidden rounded-ds-lg border border-ds-line/50 bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-ds-line/40 px-4 py-3">
              <h3 className="text-sm font-semibold text-ds-ink">Confirm Material Reservation</h3>
              <button
                type="button"
                className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
                disabled={reserveBusy}
                onClick={() => setReserveConfirmOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="max-h-[85vh] overflow-y-auto px-4 py-3">
              {!reserveConfirm ? (
                <p className="text-xs text-ds-ink-faint">No material selected.</p>
              ) : (
                <div className="space-y-3 text-xs">
                  <div className="sticky top-0 z-10 rounded border border-ds-line/50 bg-background/95 px-3 py-2 backdrop-blur">
                    <p className="mb-1 text-[11px] uppercase tracking-wide text-ds-ink-faint">Decision Summary</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] md:grid-cols-4">
                      <span>Material: <span className={`${mono} text-ds-ink`}>{reserveConfirm.materialCode || '-'}</span></span>
                      <span>Free: <span className={`${mono} text-ds-ink`}>{Number(reserveConfirm.freeSheets || 0).toLocaleString('en-IN')}</span></span>
                      <span>Required: <span className={`${mono} text-ds-ink`}>{Number(reserveConfirm.requiredParentSheets || 0).toLocaleString('en-IN')}</span></span>
                      <span>Reserve: <span className={`${mono} text-ds-ink`}>{Number(reserveConfirm.reserveQty || 0).toLocaleString('en-IN')}</span></span>
                      <span>Shortage: <span className={`${mono} text-ds-ink`}>{Number(reserveConfirm.shortageQty || 0).toLocaleString('en-IN')}</span></span>
                      <span>PR: <span className={`${mono} text-ds-ink`}>{Number(reserveConfirm.prQty || 0).toLocaleString('en-IN')}</span></span>
                      <span className="col-span-2">
                        Status:{' '}
                        <span className={
                          reserveConfirm.shortageQty <= 0
                            ? 'text-ds-success'
                            : reserveConfirm.reserveQty > 0
                              ? 'text-ds-warning'
                              : 'text-ds-danger'
                        }>
                          {reserveConfirm.shortageQty <= 0
                            ? 'Ready'
                            : reserveConfirm.reserveQty > 0
                              ? 'Partial'
                              : 'Shortage'}
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className="text-ds-ink-muted">Material Code</span><p className={mono}>{reserveConfirm.materialCode || '-'}</p></div>
                    <div><span className="text-ds-ink-muted">Parent Size</span><p className={mono}>{reserveConfirm.parentSize || '-'}</p></div>
                    <div><span className="text-ds-ink-muted">GSM</span><p className={mono}>{reserveConfirm.gsm ?? '-'}</p></div>
                    <label className="block">
                      <span className="text-ds-ink-muted">Cuts per Sheet</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className={`${fieldInput} ${mono}`}
                        value={reserveConfirm.selectedCutsPerSheetInput}
                        onChange={(e) => {
                          const raw = e.target.value
                          const parsed = Number(raw)
                          setReserveConfirm((prev) => {
                            if (!prev) return prev
                            if (!Number.isFinite(parsed)) return { ...prev, selectedCutsPerSheetInput: raw }
                            const safe = Math.max(1, parsed)
                            const capped =
                              !prev.isCutsManualOverride && safe > prev.calculatedCutsPerSheet
                                ? prev.calculatedCutsPerSheet
                                : safe
                            return computeReserveDraftFromCuts({ ...prev, selectedCutsPerSheetInput: raw }, capped, reservePrEdited)
                          })
                        }}
                        onBlur={() => {
                          const parsed = Number(reserveConfirm.selectedCutsPerSheetInput)
                          const safe = Number.isFinite(parsed) ? Math.max(1, parsed) : reserveConfirm.calculatedCutsPerSheet
                          const capped =
                            !reserveConfirm.isCutsManualOverride && safe > reserveConfirm.calculatedCutsPerSheet
                              ? reserveConfirm.calculatedCutsPerSheet
                              : safe
                          setReserveConfirm((prev) =>
                            prev ? computeReserveDraftFromCuts({ ...prev, selectedCutsPerSheetInput: String(capped) }, capped, reservePrEdited) : prev,
                          )
                        }}
                      />
                    </label>
                    <div><span className="text-ds-ink-muted">Required Parent Sheets</span><p className={mono}>{reserveConfirm.requiredParentSheets}</p></div>
                    <div><span className="text-ds-ink-muted">Available Sheets</span><p className={mono}>{reserveConfirm.availableSheets}</p></div>
                    <div><span className="text-ds-ink-muted">Reserved Sheets</span><p className={mono}>{reserveConfirm.reservedSheets}</p></div>
                    <div><span className="text-ds-ink-muted">Free Sheets</span><p className={mono}>{reserveConfirm.freeSheets}</p></div>
                    <div><span className="text-ds-ink-muted">Already Reserved Sheets</span><p className={mono}>{reserveConfirm.alreadyReservedSheets}</p></div>
                    <div><span className="text-ds-ink-muted">Current Shortage Sheets</span><p className={mono}>{reserveConfirm.currentShortageSheets}</p></div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 rounded border border-ds-line/30 bg-ds-elevated/20 p-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={reserveConfirm.isCutsManualOverride}
                        onChange={(e) =>
                          setReserveConfirm((prev) =>
                            prev ? { ...prev, isCutsManualOverride: e.target.checked } : prev,
                          )
                        }
                      />
                      <span className="text-ds-ink-muted">Manual Override</span>
                    </label>
                    {reserveConfirm.isCutsManualOverride ? (
                      <input
                        type="text"
                        className={fieldInput}
                        placeholder="Override reason (optional)"
                        value={reserveConfirm.overrideReason}
                        onChange={(e) =>
                          setReserveConfirm((prev) => (prev ? { ...prev, overrideReason: e.target.value } : prev))
                        }
                      />
                    ) : null}
                    <p className="text-ds-ink-faint">
                      Calculated cuts: <span className={mono}>{reserveConfirm.calculatedCutsPerSheet}</span> · Selected reason: {reserveConfirm.selectedReason}
                    </p>
                  </div>
                  {reserveConfirm.freeSheets <= 0 ? (
                    <p className="rounded border border-ds-warning/35 bg-ds-warning/10 px-2 py-1 text-ds-warning">
                      Stock is over-reserved. Release stock or create PR.
                    </p>
                  ) : null}
                  {readiness?.prId ? (
                    <p className="rounded border border-ds-warning/35 bg-ds-warning/10 px-2 py-1 text-ds-warning">
                      PR already exists for this line ({readiness.prStatus || 'open'}).
                    </p>
                  ) : null}
                  {(optionDetailsByMaterial[reserveConfirm.materialId]?.reservations || []).length > 1 ? (
                    <p className="rounded border border-ds-warning/35 bg-ds-warning/10 px-2 py-1 text-ds-warning">
                      Stock is currently used by multiple jobs/lines. Verify before reserving.
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-ds-ink-muted">Reserve Qty</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className={`${fieldInput} ${mono}`}
                        value={reserveConfirm.reserveQtyInput}
                        onChange={(e) => {
                          const raw = e.target.value
                          setReserveConfirm((prev) => prev ? { ...prev, reserveQtyInput: raw } : prev)
                          const parsed = Number(raw)
                          if (!Number.isFinite(parsed)) return
                          const cap = Math.min(Math.max(0, reserveConfirm.freeSheets), reserveConfirm.requiredParentSheets)
                          const reserveQty = Math.min(Math.max(0, parsed), cap)
                          const shortageQty = Math.max(0, reserveConfirm.requiredParentSheets - reserveQty)
                          const leftoverAvailableAfterReserve = Math.max(0, Math.max(0, reserveConfirm.freeSheets) - reserveQty)
                          setReserveConfirm((prev) => prev ? {
                            ...prev,
                            reserveQty,
                            shortageQty,
                            reserveQtyInput: raw,
                            prQty: reservePrEdited ? prev.prQty : shortageQty,
                            prQtyInput: reservePrEdited ? prev.prQtyInput : String(shortageQty),
                            leftoverAvailableAfterReserve,
                          } : prev)
                        }}
                        onBlur={() => {
                          const parsed = Number(reserveConfirm.reserveQtyInput)
                          const cap = Math.min(Math.max(0, reserveConfirm.freeSheets), reserveConfirm.requiredParentSheets)
                          const reserveQty = Number.isFinite(parsed) ? Math.min(Math.max(0, parsed), cap) : Math.min(reserveConfirm.requiredParentSheets, Math.max(0, reserveConfirm.freeSheets))
                          const shortageQty = Math.max(0, reserveConfirm.requiredParentSheets - reserveQty)
                          const leftoverAvailableAfterReserve = Math.max(0, Math.max(0, reserveConfirm.freeSheets) - reserveQty)
                          setReserveConfirm((prev) => prev ? {
                            ...prev,
                            reserveQty,
                            reserveQtyInput: String(reserveQty),
                            shortageQty,
                            prQty: reservePrEdited ? prev.prQty : shortageQty,
                            prQtyInput: reservePrEdited ? prev.prQtyInput : String(shortageQty),
                            leftoverAvailableAfterReserve,
                          } : prev)
                        }}
                      />
                    </label>
                    <label className="block">
                      <span className="text-ds-ink-muted">PR Qty</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className={`${fieldInput} ${mono}`}
                        value={reserveConfirm.prQtyInput}
                        onChange={(e) => {
                          const raw = e.target.value
                          setReservePrEdited(true)
                          setReserveConfirm((prev) => prev ? {
                            ...prev,
                            prQtyInput: raw,
                            prQty: Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : prev.prQty,
                          } : prev)
                        }}
                        onBlur={() => {
                          const parsed = Number(reserveConfirm.prQtyInput)
                          const prQty = Number.isFinite(parsed) ? Math.max(0, parsed) : Math.max(0, reserveConfirm.prQty)
                          setReserveConfirm((prev) => prev ? { ...prev, prQty, prQtyInput: String(prQty) } : prev)
                        }}
                      />
                    </label>
                    <div><span className="text-ds-ink-muted">Shortage Qty</span><p className={`${mono} text-ds-ink`}>{reserveConfirm.shortageQty}</p></div>
                    <div><span className="text-ds-ink-muted">Leftover Available After Reserve</span><p className={`${mono} text-ds-ink`}>{reserveConfirm.leftoverAvailableAfterReserve}</p></div>
                  </div>
                  <div className="space-y-2 rounded border border-ds-line/40 bg-ds-elevated/20 p-2">
                    <p className="text-ds-ink-muted">Leftover / Offcut Details</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div><span className="text-ds-ink-faint">Parent Sheet Size</span><p className={mono}>{reserveConfirm.parentSize || '-'}</p></div>
                      <div><span className="text-ds-ink-faint">Cut Size Used</span><p className={mono}>{reserveConfirm.cutSizeUsed || '-'}</p></div>
                      <div><span className="text-ds-ink-faint">Cuts Per Parent Sheet</span><p className={mono}>{reserveConfirm.cutsPerSheet}</p></div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        className={`${fieldInput} ${mono}`}
                        placeholder="Leftover length"
                        value={reserveConfirm.leftoverLengthInput}
                        onChange={(e) =>
                          setReserveConfirm((prev) => {
                            if (!prev) return prev
                            const leftoverLengthInput = e.target.value
                            const leftoverLength = Number(leftoverLengthInput) || 0
                            const leftoverWidth = Number(prev.leftoverWidthInput) || 0
                            const leftoverQty = Number(prev.leftoverQtyInput) || 0
                            const gsm = Number(prev.gsm || 0)
                            const leftoverWeightKg = Number(((leftoverLength * leftoverWidth * gsm * leftoverQty) / 1000000).toFixed(6))
                            return { ...prev, leftoverLengthInput, leftoverWeightKg }
                          })
                        }
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        className={`${fieldInput} ${mono}`}
                        placeholder="Leftover width"
                        value={reserveConfirm.leftoverWidthInput}
                        onChange={(e) =>
                          setReserveConfirm((prev) => {
                            if (!prev) return prev
                            const leftoverWidthInput = e.target.value
                            const leftoverLength = Number(prev.leftoverLengthInput) || 0
                            const leftoverWidth = Number(leftoverWidthInput) || 0
                            const leftoverQty = Number(prev.leftoverQtyInput) || 0
                            const gsm = Number(prev.gsm || 0)
                            const leftoverWeightKg = Number(((leftoverLength * leftoverWidth * gsm * leftoverQty) / 1000000).toFixed(6))
                            return { ...prev, leftoverWidthInput, leftoverWeightKg }
                          })
                        }
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        className={`${fieldInput} ${mono}`}
                        placeholder="Leftover qty"
                        value={reserveConfirm.leftoverQtyInput}
                        onChange={(e) =>
                          setReserveConfirm((prev) => {
                            if (!prev) return prev
                            const leftoverQtyInput = e.target.value
                            const leftoverLength = Number(prev.leftoverLengthInput) || 0
                            const leftoverWidth = Number(prev.leftoverWidthInput) || 0
                            const leftoverQty = Number(leftoverQtyInput) || 0
                            const gsm = Number(prev.gsm || 0)
                            const leftoverWeightKg = Number(((leftoverLength * leftoverWidth * gsm * leftoverQty) / 1000000).toFixed(6))
                            return { ...prev, leftoverQtyInput, leftoverWeightKg }
                          })
                        }
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div><span className="text-ds-ink-faint">Leftover Weight KG</span><p className={mono}>{reserveConfirm.leftoverWeightKg}</p></div>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={reserveConfirm.addLeftoverToWarehouse}
                          onChange={(e) =>
                            setReserveConfirm((prev) => (prev ? { ...prev, addLeftoverToWarehouse: e.target.checked } : prev))
                          }
                        />
                        <span className="text-ds-ink-muted">Add leftover to Paper Warehouse</span>
                      </label>
                    </div>
                    <input
                      type="text"
                      className={fieldInput}
                      placeholder="Leftover remarks"
                      value={reserveConfirm.leftoverRemarks}
                      onChange={(e) =>
                        setReserveConfirm((prev) => (prev ? { ...prev, leftoverRemarks: e.target.value } : prev))
                      }
                    />
                  </div>
                  <div className="rounded border border-ds-line/40 bg-ds-elevated/20 p-2">
                    <p className="mb-1 text-ds-ink-muted">Already Reserved Under This Material</p>
                    {(optionDetailsByMaterial[reserveConfirm.materialId]?.reservations || []).length === 0 ? (
                      <p className="text-ds-ink-faint">No active reservations for this material.</p>
                    ) : (
                      <ul className="space-y-1">
                        {(optionDetailsByMaterial[reserveConfirm.materialId]?.reservations || []).slice(0, 8).map((r) => (
                          <li key={r.id} className="rounded border border-ds-line/30 px-2 py-1">
                            {r.jobCard ? `Job Card #${r.jobCard.jobCardNumber}` : `Planning Line ${r.planningId || '-'}`} · {r.cartonName || '-'} · {Number(r.reservedSheets || 0).toLocaleString('en-IN')} · {r.reservedAt ? new Date(r.reservedAt).toLocaleString('en-IN') : '-'} · {r.status || '-'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {reserveConfirm.prQty < reserveConfirm.shortageQty ? (
                    <p className="text-ds-warning">PR Qty is less than shortage. Remaining shortage will stay open.</p>
                  ) : null}
                  {reserveConfirm.shortageQty > 0 && reserveConfirm.prQty === 0 ? (
                    <p className="text-ds-warning">Shortage will remain without PR.</p>
                  ) : null}
                  {reserveModalError ? (
                    <div className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)]/10 px-2 py-1 text-xs text-[var(--error)]">
                      {reserveModalError}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-ds-line/40 px-4 py-3">
              <Button
                type="button"
                variant="secondary"
                disabled={reserveBusy}
                onClick={() => setReserveConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={
                  !reserveConfirm ||
                  reserveBusy ||
                  reserveConfirm.reserveQty < 0 ||
                  reserveConfirm.reserveQty > Math.max(0, reserveConfirm.freeSheets) ||
                  reserveConfirm.reserveQty > reserveConfirm.requiredParentSheets ||
                  reserveConfirm.prQty < 0
                }
                onClick={() => { void handleReserveMaterial() }}
              >
                {reserveBusy ? 'Reserving…' : 'Confirm Reserve'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {reservationControlOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl overflow-hidden rounded-ds-lg border border-ds-line/50 bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-ds-line/40 px-4 py-3">
              <h3 className="text-sm font-semibold text-ds-ink">
                {reservationControl?.mode === 'adjust'
                  ? 'Adjust Reservation'
                  : reservationControl?.mode === 'release'
                    ? 'Release Reservation'
                    : 'Generate Purchase Request'}
              </h3>
              <button
                type="button"
                className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40"
                disabled={reservationControlBusy}
                onClick={() => setReservationControlOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="max-h-[85vh] overflow-y-auto px-4 py-3">
              {!reservationControl ? (
                <p className="text-xs text-ds-ink-faint">-</p>
              ) : (
                <div className="space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className="text-ds-ink-muted">Material Code</span><p className={mono}>{reservationControl.materialCode}</p></div>
                    <div><span className="text-ds-ink-muted">Required Sheets</span><p className={mono}>{reservationControl.requiredSheets}</p></div>
                    <div><span className="text-ds-ink-muted">Before Available</span><p className={mono}>{reservationControl.availableSheets}</p></div>
                    <div><span className="text-ds-ink-muted">Before Reserved</span><p className={mono}>{reservationControl.reservedSheetsTotal}</p></div>
                    <div><span className="text-ds-ink-muted">Current Reserved (this line)</span><p className={mono}>{reservationControl.currentReservedForLine}</p></div>
                    <div><span className="text-ds-ink-muted">Current Shortage</span><p className={mono}>{reservationControl.currentShortageSheets}</p></div>
                  </div>
                  {reservationControl.mode !== 'release' ? (
                    <label className="block">
                      <span className="text-ds-ink-muted">Reserve Qty</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className={`${fieldInput} ${mono}`}
                        value={reservationControl.reserveQtyInput}
                        onChange={(e) => {
                          const next = updateReservationControlDerived({
                            ...reservationControl,
                            reserveQtyInput: e.target.value,
                          })
                          setReservationControl(next)
                        }}
                        onBlur={() => {
                          const n = Number(reservationControl.reserveQtyInput)
                          const safe = Number.isFinite(n) ? Math.max(0, n) : 0
                          const next = updateReservationControlDerived({
                            ...reservationControl,
                            reserveQtyInput: String(safe),
                          })
                          setReservationControl(next)
                        }}
                      />
                    </label>
                  ) : (
                    <label className="block">
                      <span className="text-ds-ink-muted">Release Qty</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className={`${fieldInput} ${mono}`}
                        value={reservationControl.releaseQtyInput}
                        onChange={(e) => {
                          const next = updateReservationControlDerived({
                            ...reservationControl,
                            releaseQtyInput: e.target.value,
                          })
                          setReservationControl(next)
                        }}
                        onBlur={() => {
                          const n = Number(reservationControl.releaseQtyInput)
                          const safe = Number.isFinite(n) ? Math.max(0, n) : 0
                          const next = updateReservationControlDerived({
                            ...reservationControl,
                            releaseQtyInput: String(safe),
                          })
                          setReservationControl(next)
                        }}
                      />
                    </label>
                  )}
                  <label className="block">
                    <span className="text-ds-ink-muted">PR Qty</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      className={`${fieldInput} ${mono}`}
                      value={reservationControl.prQtyInput}
                      onChange={(e) => {
                        const raw = e.target.value
                        const parsed = Number(raw)
                        setReservationControl((prev) =>
                          prev
                            ? {
                                ...prev,
                                prQtyInput: raw,
                                prQty: Number.isFinite(parsed) ? Math.max(0, parsed) : prev.prQty,
                                warningMessage:
                                  Number.isFinite(parsed) && Math.max(0, parsed) < prev.shortageQty
                                    ? 'PR Qty is less than shortage. Remaining shortage will stay open.'
                                    : null,
                              }
                            : prev,
                        )
                      }}
                    />
                  </label>
                  {reservationControl.mode === 'release' ? (
                    <label className="block">
                      <span className="text-ds-ink-muted">PR impact</span>
                      <select
                        className={fieldInput}
                        value={reservationControl.prImpactAction}
                        onChange={(e) =>
                          setReservationControl((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  prImpactAction: e.target.value as 'keep' | 'reduce' | 'cancel_if_no_shortage',
                                }
                              : prev,
                          )
                        }
                      >
                        <option value="keep">Keep PR</option>
                        <option value="reduce">Reduce PR</option>
                        <option value="cancel_if_no_shortage">Cancel PR if no shortage remains</option>
                      </select>
                    </label>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2 rounded border border-ds-line/30 bg-ds-elevated/20 p-2">
                    <div><span className="text-ds-ink-muted">Shortage Qty</span><p className={mono}>{reservationControl.shortageQty}</p></div>
                    <div><span className="text-ds-ink-muted">Leftover Available</span><p className={mono}>{reservationControl.leftoverAvailableAfterReserve}</p></div>
                  </div>
                  {reservationControl.jobCardStatus ? (
                    <p className="text-ds-warning">
                      Job Card linked ({reservationControl.jobCardStatus}). Release allowed with caution before production start.
                    </p>
                  ) : null}
                  {reservationControl.warningMessage ? (
                    <p className="text-ds-warning">{reservationControl.warningMessage}</p>
                  ) : null}
                  {reservationControlError ? (
                    <div className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)]/10 px-2 py-1 text-xs text-[var(--error)]">
                      {reservationControlError}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-ds-line/40 px-4 py-3">
              <Button
                type="button"
                variant="secondary"
                disabled={reservationControlBusy}
                onClick={() => setReservationControlOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!reservationControl || reservationControlBusy}
                onClick={() => {
                  void submitReservationControl()
                }}
              >
                {reservationControlBusy
                  ? 'Saving…'
                  : reservationControl?.mode === 'adjust'
                    ? 'Confirm Adjustment'
                    : reservationControl?.mode === 'release'
                      ? 'Confirm Release'
                      : 'Generate PR'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </PlanningEngineModal>
  )
}
