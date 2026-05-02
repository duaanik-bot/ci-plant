'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Layers, PauseCircle, Star } from 'lucide-react'
import { toast } from 'sonner'
import { broadcastIndustrialPriorityChange } from '@/lib/industrial-priority-sync'
import { INDUSTRIAL_PRIORITY_STAR_ICON_CLASS } from '@/lib/industrial-priority-ui'
import {
  MASTER_EMBOSSING_AND_LEAFING,
} from '@/lib/master-enums'
import { fetchMiniMasterOptions } from '@/lib/minimasters-options'
import { mergePlanningMetaUps, readPlanningMeta } from '@/lib/planning-decision-spec'
import { resolveSheetSize } from '@/lib/planning-sheet-size'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { PlanningGridLine, type PlanningLineFieldPatch } from '@/components/planning/PlanningDecisionGrid'
import { StandardDrawer } from '@/components/design-system/StandardDrawer'
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
  incomingSheets: number
  shortageSheets: number
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
    cutsPerSheet: number
    requiredParentSheets: number
    shortageParentSheets: number
    wastagePct: number
    yieldPct: number
    orientation: 'LxW' | 'WxL'
    matchType: 'Exact' | 'Size Fit' | 'GSM Tolerance'
    status: 'Ready' | 'Partial' | 'Shortage'
    tags: Array<'Best Yield' | 'Least Wastage' | 'Closest GSM' | 'Most Available'>
    gsmDelta: number | null
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
    cutsPerSheet: number
    requiredParentSheets: number
    shortageParentSheets: number
    wastagePct: number
    yieldPct: number
    orientation: 'LxW' | 'WxL'
    matchType: 'Exact' | 'Size Fit' | 'GSM Tolerance'
    status: 'Ready' | 'Partial' | 'Shortage'
    tags: Array<'Best Yield' | 'Least Wastage' | 'Closest GSM' | 'Most Available'>
    gsmDelta: number | null
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
    requiredSheets: number
    reservedSheets: number
    status: string
    cartonName: string | null
    jobCard: { jobCardNumber: number; status: string }
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
  const [coatingOptions, setCoatingOptions] = useState<string[]>([])
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
    let cancelled = false
    ;(async () => {
      try {
        const [coating, materialsRes] = await Promise.all([
          fetchMiniMasterOptions('Coating'),
          fetch('/api/masters/materials', { cache: 'no-store' }),
        ])
        if (cancelled) return
        if (coating.length > 0) setCoatingOptions(coating)
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
      const qs = selectedMaterialId ? `?materialId=${encodeURIComponent(selectedMaterialId)}` : ''
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
        incomingSheets: Number(out.incomingSheets) || 0,
        shortageSheets: Number(out.shortageSheets) || 0,
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

  const handleReserveMaterial = useCallback(async (materialIdArg?: string, cutsPerSheetArg?: number, parentSizeArg?: string) => {
    if (!line) return
    setReserveBusy(true)
    try {
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
          : (readiness?.suggestedBoardOptions || []).find((o) => o.materialId === chosenMaterialId) || null
      const res = await fetch(`/api/planning/po-lines/${line.id}/reserve-material`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(chosenMaterialId ? { materialId: chosenMaterialId } : {}),
          wastageSheets,
          requiredSheets,
          ...(selectedOption
            ? { cutsPerSheet: selectedOption.cutsPerSheet, parentSize: selectedOption.size }
            : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const errData = data as { error?: string; retryable?: boolean; shortageId?: string }
        if (errData.retryable && errData.shortageId) {
          toast.error(errData.error || 'Reservation completed, but PR creation failed.', {
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
        throw new Error(errData.error || 'Reservation failed')
      }
      const out = data as { status: string; reservedSheets: number; shortageSheets: number; purchaseRequestId?: string | null }
      const msg =
        out.status === 'fully_reserved'
          ? `Fully reserved (${out.reservedSheets.toLocaleString('en-IN')} sheets).`
          : `Partial reserved (${out.reservedSheets.toLocaleString('en-IN')}) · shortage ${out.shortageSheets.toLocaleString('en-IN')}${out.purchaseRequestId ? ' · PR created' : ''}.`
      toast.success(msg)
      if (chosenMaterialId) {
        setSelectedMaterialId(chosenMaterialId)
        setSelectionLocked(true)
      }
      await loadReadiness()
      window.dispatchEvent(new Event('planning:refresh'))
      window.dispatchEvent(new Event('inventory:refresh'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reservation failed')
    } finally {
      setReserveBusy(false)
    }
  }, [line, loadReadiness, selectedMaterialId, readiness?.materialId, wastageSheetsInput, readiness?.suggestedBoardOptions])

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
          specialInstructions: JSON.stringify({
            notes: '',
            brailleEnabled: false,
            leafingEnabled: false,
            embossingEnabled: false,
            spotUvEnabled: false,
            ups,
          }),
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

  if (!line || !open) return null

  const spec = (line.specOverrides || {}) as Record<string, unknown>
  const renderUpsField = true
  const meta = readPlanningMeta(spec)
  const gangUpsStr =
    renderUpsField && meta.ups != null && Number(meta.ups) >= 1
      ? String(Math.floor(Number(meta.ups)))
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
  const hasDecisionInputs =
    !!resolvedSheetSize && resolvedSheetSize !== '-' &&
    calcQty > 0 &&
    calcUps > 0

  return (
    <StandardDrawer
      isOpen={open}
      onClose={onClose}
      title={<span className="truncate text-ds-ink" title={line.cartonName}>{line.cartonName}</span>}
      metadata={
        <div className="space-y-2">
          <p className="text-xs text-ds-ink-faint">
            {line.po.poNumber} · {line.planningStatus} · {line.po.customer.name}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {line.po.isPriority ? (
              <Badge
                tone="warning"
                className={`inline-flex items-center gap-0.5 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`}
              >
                <Star className="h-3 w-3 fill-current" aria-hidden />
                PO
              </Badge>
            ) : null}
            {line.directorPriority ? (
              <Badge tone="brand" className="text-xs">
                Line priority
              </Badge>
            ) : null}
            {line.directorHold ? (
              <Badge tone="warning" className="text-xs">
                On hold
              </Badge>
            ) : null}
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
        </div>
      }
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
      primaryAction={{
        label: 'Save',
        loadingLabel: 'Saving…',
        onClick: () => {
          void handleSave()
        },
        disabled: saving,
        loading: saving,
      }}
    >
      <div className="space-y-3 text-sm text-ds-ink" aria-label="Job detail">
        <CardSection title="Job Snapshot" id="plan-drawer-job-snapshot">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div><span className="text-ds-ink-muted">Carton/Product</span><p className="text-ds-ink">{line.cartonName || '-'}</p></div>
            <div><span className="text-ds-ink-muted">Customer</span><p className="text-ds-ink">{line.po.customer.name || '-'}</p></div>
            <div><span className="text-ds-ink-muted">PO Ref</span><p className={`${mono} text-ds-ink`}>{line.po.poNumber || '-'}</p></div>
            <div><span className="text-ds-ink-muted">Qty</span><p className={`${mono} text-ds-ink`}>{Number(line.quantity || 0).toLocaleString('en-IN')}</p></div>
          </div>
        </CardSection>

        <CardSection title="Material + Sheet Size" id="plan-drawer-material">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="ds-typo-label">Size</p>
              <input
                className={`${fieldInput} ${mono}`}
                value={line.cartonSize ?? ''}
                onChange={(e) => updateRow(line.id, { cartonSize: e.target.value || null })}
                onBlur={(e) => void onSaveLine(line.id, { cartonSize: e.target.value.trim() || null })}
              />
            </div>
            <div>
              <p className="ds-typo-label">Qty</p>
              <input
                type="number"
                min={1}
                className={`${fieldInput} ${mono} font-semibold text-ds-ink tabular-nums`}
                value={line.quantity}
                onChange={(e) => {
                  const n = Math.max(1, parseInt(e.target.value, 10) || 1)
                  updateRow(line.id, { quantity: n })
                }}
                onBlur={() => void onSaveLine(line.id, { quantity: line.quantity })}
              />
            </div>
          </div>
          <label className="mt-1 block">
            <span className="ds-typo-label">Board Classification</span>
            <input
              className={fieldInput + ' ' + mono}
              value={boardInput}
              placeholder="e.g. kraft, virgin"
              onChange={(e) => {
                const v = e.target.value
                const next = { ...spec, boardGrade: v || null } as Record<string, unknown>
                updateRow(line.id, { specOverrides: next })
              }}
              onBlur={(e) => {
                const v = e.target.value.trim()
                const next = { ...spec, boardGrade: v || null } as Record<string, unknown>
                void onSaveLine(line.id, {}, next)
              }}
            />
          </label>
          <div>
            <p className="ds-typo-label">GSM</p>
            <input
              type="number"
              className={fieldInput + ' ' + mono}
              value={line.gsm ?? line.carton?.gsm ?? ''}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                updateRow(line.id, { gsm: Number.isFinite(n) ? n : null })
              }}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10)
                const g = Number.isFinite(n) ? n : null
                void onSaveLine(line.id, { gsm: g })
              }}
            />
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <p className="ds-typo-label">Board Type</p>
            <PackagingEnumCombobox
              aria-label="Board Type"
              options={boardTypeOptions}
              value={line.paperType ?? line.carton?.paperType ?? null}
              onChange={(v) => {
                updateRow(line.id, { paperType: v })
                void onSaveLine(line.id, { paperType: v })
              }}
              className="w-full"
              controlClassName={comboControl}
              inputClassName={comboInput}
            />
          </div>
          <div>
            <p className="ds-typo-label">Sheet Size</p>
            <input className={`${fieldInput} ${mono}`} value={resolvedSheetSize} readOnly />
          </div>
          <div>
            <p className="ds-typo-label">UPS</p>
            <input className={`${fieldInput} ${mono}`} value={gangUpsStr || '-'} readOnly />
          </div>
        </CardSection>

        <CardSection title="Material Readiness" id="plan-drawer-material-readiness">
          <div className={`rounded-ds-md border px-3 py-3 text-xs ${statusTone}`}>
            <p className="text-sm font-semibold text-ds-ink">Material Readiness</p>
            <p className="mt-1 text-xs text-ds-ink-muted">
              {readinessLoading ? 'Loading material readiness…' : noMaterialSelected ? 'No material selected.' : materialSummary}
            </p>
          </div>
          {readiness?.materialMatchState === 'multiple' && (readiness.materialCandidates?.length ?? 0) > 1 ? (
            <div>
              <p className="ds-typo-label">Select matching material</p>
              <select
                className={fieldInput}
                value={selectedMaterialId}
                onChange={(e) => setSelectedMaterialId(e.target.value)}
              >
                <option value="">Select matching material</option>
                {(readiness.materialCandidates || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.materialCode} - {c.description}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {readiness?.materialMatchState === 'none' ? (
            <p className="text-xs text-ds-warning">No matching material in Paper Warehouse.</p>
          ) : null}
          <div className="mt-2 space-y-2">
            <p className="text-xs font-semibold text-ds-ink">Suggested Board Options</p>
            <p className="text-[11px] text-ds-ink-faint">
              Suggestions are ranked by cuts, wastage, GSM match, and stock availability. User must manually lock material before reservation.
            </p>
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-ds-ink-faint">
                Mapping: {readiness?.mappingSafety?.strategyUsed || '-'} · candidates {readiness?.mappingSafety?.candidatePoolCount ?? 0} · strict {readiness?.mappingSafety?.strictPoolCount ?? 0}
              </p>
              <button
                type="button"
                className="text-xs font-medium text-ds-brand underline-offset-2 hover:underline"
                onClick={() => setSuggestionsWorkspaceOpen(true)}
              >
                Open Suggestion Workspace
              </button>
            </div>
            {!hasDecisionInputs ? (
              <p className="text-xs text-ds-warning">Suggestions load when Sheet Size, Qty, and UPS are available.</p>
            ) : readiness?.noMaterialsAtAll ? (
              <p className="text-xs text-ds-warning">No materials exist in Paper Warehouse yet.</p>
            ) : (readiness?.suggestedBoardOptions?.length || 0) === 0 && (readiness?.closestAvailableOptions?.length || 0) === 0 ? (
              <p className="text-xs text-ds-warning">No suitable stock found. Create PR?</p>
            ) : (
              <div className="space-y-2">
                {!!readiness?.debugMessage && (
                  <p className="text-xs text-ds-warning">{readiness.debugMessage}</p>
                )}
                {(
                  ((readiness?.suggestedBoardOptions?.length || 0) > 0
                    ? readiness?.suggestedBoardOptions
                    : readiness?.closestAvailableOptions) || []
                ).slice(0, 10).map((opt) => {
                  const selected = selectedMaterialId === opt.materialId
                  const openOpt = !!optionDetailsOpen[opt.materialId]
                  const optDetails = optionDetailsByMaterial[opt.materialId]
                  const optLoading = !!optionDetailsLoading[opt.materialId]
                  const isFallback = (readiness?.suggestedBoardOptions?.length || 0) === 0
                  return (
                    <div
                      key={opt.materialId}
                      className={`w-full rounded border px-2 py-2 text-left text-xs ${
                        selected ? 'border-ds-warning/50 bg-ds-warning/10' : 'border-ds-line/40 bg-background'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className={`${mono} text-ds-ink`}>
                          {opt.materialCode} · {opt.size} · {opt.gsm ?? '-'} GSM
                        </p>
                        <div className="flex items-center gap-2">
                          {(opt.tags || []).map((tag) => (
                            <span key={tag} className="text-[10px] text-ds-success">{tag}</span>
                          ))}
                          {isFallback ? <span className="text-[10px] text-ds-warning">Not Ideal - Check Manually</span> : null}
                          <span className="text-[10px] text-ds-ink-faint">{opt.matchType}</span>
                          <span className={`text-[10px] ${
                            opt.status === 'Ready'
                              ? 'text-ds-success'
                              : opt.status === 'Partial'
                                ? 'text-ds-warning'
                                : 'text-ds-danger'
                          }`}>{opt.status}</span>
                          <span className="text-[10px] text-ds-ink-faint">
                            {opt.boardMatchMode === 'exact' ? 'Board exact' : opt.boardMatchMode === 'cross_field' ? 'Board mapped' : 'Board fallback'}
                          </span>
                        </div>
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-ds-ink-faint">
                        <span>Cuts/Sheet: {opt.cutsPerSheet}</span>
                        <span>Req Parent: {opt.requiredParentSheets}</span>
                        <span>Available: {opt.availableSheets}</span>
                        <span>Wastage: {opt.wastagePct}%</span>
                        <span>Status: {opt.status}</span>
                        <span>
                          {opt.gsmDelta != null ? `GSM Δ ${opt.gsmDelta} (±${readiness?.gsmTolerance ?? 10})` : '-'}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          disabled={reserveBusy}
                          onClick={() => void handleReserveMaterial(opt.materialId, opt.cutsPerSheet, opt.size)}
                          className="h-8 px-2 text-xs"
                        >
                          {reserveBusy && selectedMaterialId === opt.materialId ? 'Reserving…' : 'Select & Reserve'}
                        </Button>
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
                      {openOpt ? (
                        <div className="mt-2 rounded border border-ds-line/30 bg-ds-elevated/20 p-2 text-xs">
                          {optLoading ? (
                            <p className="text-ds-ink-faint">Loading…</p>
                          ) : !optDetails ? (
                            <p className="text-ds-ink-faint">-</p>
                          ) : (
                            <>
                              <div className="grid grid-cols-2 gap-1">
                                <span>Available: {Math.max(0, readiness?.availableSheets || 0).toLocaleString('en-IN')}</span>
                                <span>Reserved: {Math.max(0, readiness?.reservedSheets || 0).toLocaleString('en-IN')}</span>
                                <span>Incoming: {Math.max(0, readiness?.incomingSheets || 0).toLocaleString('en-IN')}</span>
                                <span>Shortage: {Math.max(0, readiness?.shortageSheets || 0).toLocaleString('en-IN')}</span>
                              </div>
                              <div className="mt-2">
                                <p className="text-ds-ink-muted mb-1">Recent logs</p>
                                {(optDetails.logs || []).length === 0 ? (
                                  <p className="text-ds-ink-faint">No logs.</p>
                                ) : (
                                  <ul className="space-y-1">
                                    {optDetails.logs.slice(0, 5).map((l) => (
                                      <li key={l.id} className="rounded border border-ds-line/20 px-1.5 py-0.5">
                                        {new Date(l.createdAt).toLocaleString('en-IN')} · {l.movementType} · {Number(l.qty).toLocaleString('en-IN')}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
                <div className="flex items-center justify-between">
                  <p className="text-xs text-ds-ink-faint">
                    Selected: {selectedMaterialId ? (readiness?.suggestedBoardOptions || readiness?.closestAvailableOptions || []).find((o) => o.materialId === selectedMaterialId)?.materialCode || selectedMaterialId : 'None'}
                  </p>
                  <button
                    type="button"
                    disabled={!selectedMaterialId}
                    onClick={() => setSelectionLocked(true)}
                    className="rounded border border-ds-line/40 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/40 disabled:opacity-40"
                  >
                    {selectionLocked ? 'Selection Locked' : 'Lock Selection'}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div><span className="text-ds-ink-muted">Sheet Size</span><p className={`${mono} text-ds-ink`}>{resolvedSheetSize || '-'}</p></div>
            <div><span className="text-ds-ink-muted">Qty / UPS</span><p className={`${mono} text-ds-ink`}>{calcQty.toLocaleString('en-IN')} / {calcUps.toLocaleString('en-IN')}</p></div>
            <div>
              <span className="text-ds-ink-muted">Wastage (sheets)</span>
              <input
                type="number"
                min={0}
                className={`${fieldInput} ${mono} mt-1`}
                value={wastageSheetsInput}
                onChange={(e) => setWastageSheetsInput(e.target.value)}
                onBlur={(e) => {
                  const n = Math.max(0, Math.floor(Number(e.target.value || 0)))
                  const next = Number.isFinite(n) ? n : 150
                  setWastageSheetsInput(String(next))
                  const specNow = (line.specOverrides || {}) as Record<string, unknown>
                  const update = { ...specNow, wastageSheets: next } as Record<string, unknown>
                  updateRow(line.id, { specOverrides: update })
                  void onSaveLine(line.id, { specOverrides: update })
                  void loadReadiness()
                }}
              />
            </div>
            <div><span className="text-ds-ink-muted">Base Sheets (Qty / UPS)</span><p className={`${mono} text-ds-ink`}>{calcBaseSheets.toLocaleString('en-IN')}</p></div>
            <div><span className="text-ds-ink-muted">Total Required (Base + Wastage)</span><p className={`${mono} text-ds-ink`}>{calcRequiredSheets.toLocaleString('en-IN')}</p></div>
            <div />
            <div><span className="text-ds-ink-muted">Material Code</span><p className={`${mono} text-ds-ink`}>{readiness?.materialCode || '-'}</p></div>
            <div><span className="text-ds-ink-muted">Board Type</span><p className="text-ds-ink">{readiness?.boardType || '-'}</p></div>
            <div><span className="text-ds-ink-muted">Board Classification</span><p className="text-ds-ink">{readiness?.boardClassification || '-'}</p></div>
            <div><span className="text-ds-ink-muted">Size</span><p className={`${mono} text-ds-ink`}>{readiness?.size || '-'}</p></div>
            <div><span className="text-ds-ink-muted">GSM</span><p className={`${mono} text-ds-ink`}>{readiness?.gsm ? `${readiness.gsm} GSM` : '-'}</p></div>
            <div><span className="text-ds-ink-muted">Required Sheets</span><p className={`${mono} text-ds-ink`}>{Math.max(0, readiness?.requiredSheets || calcRequiredSheets).toLocaleString('en-IN')}</p></div>
            <div><span className="text-ds-ink-muted">Available Sheets</span><p className={`${mono} text-ds-ink`}>{Math.max(0, readiness?.availableSheets || 0).toLocaleString('en-IN')}</p></div>
            <div><span className="text-ds-ink-muted">Reserved Sheets</span><p className={`${mono} text-ds-ink`}>{Math.max(0, readiness?.reservedSheets || 0).toLocaleString('en-IN')}</p></div>
            <div><span className="text-ds-ink-muted">Incoming Sheets</span><p className={`${mono} text-ds-ink`}>{Math.max(0, readiness?.incomingSheets || 0).toLocaleString('en-IN')}</p></div>
            <div><span className="text-ds-ink-muted">Shortage Sheets</span><p className={`${mono} text-ds-ink`}>{Math.max(0, readiness?.shortageSheets || 0).toLocaleString('en-IN')}</p></div>
            <div><span className="text-ds-ink-muted">PR Status</span><p className="text-ds-ink">{readiness?.prStatus || '-'}</p></div>
            <div><span className="text-ds-ink-muted">GRN ETA</span><p className={`${mono} text-ds-ink`}>{readiness?.grnEta ? new Date(readiness.grnEta).toLocaleDateString('en-IN') : '-'}</p></div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-xs font-medium text-ds-brand underline-offset-2 hover:underline"
              onClick={() => {
                const next = !stockDetailsOpen
                setStockDetailsOpen(next)
                const mid = selectedMaterialId || readiness?.materialId || ''
                if (next && mid) void loadStockDetails(mid)
              }}
            >
              {stockDetailsOpen ? 'Hide Stock Details' : 'View Stock Details'}
            </button>
            {noMaterialSelected ? <span className="text-xs text-ds-warning">No material selected.</span> : null}
          </div>
          {stockDetailsOpen ? (
            <div className="rounded-ds-md border border-ds-line/40 bg-ds-elevated/30 p-3 text-xs space-y-3">
              {stockDetailsLoading ? (
                <p className="text-ds-ink-faint">Loading stock details…</p>
              ) : !stockDetails ? (
                <p className="text-ds-ink-faint">-</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className="text-ds-ink-muted">Material Code</span><p className={`${mono} text-ds-ink`}>{stockDetails.material.materialCode || '-'}</p></div>
                    <div><span className="text-ds-ink-muted">Board Type</span><p className="text-ds-ink">{stockDetails.material.boardType || '-'}</p></div>
                    <div><span className="text-ds-ink-muted">Classification</span><p className="text-ds-ink">{stockDetails.material.boardClassification || '-'}</p></div>
                    <div><span className="text-ds-ink-muted">Size</span><p className={`${mono} text-ds-ink`}>{stockDetails.material.sheetLength && stockDetails.material.sheetWidth ? `${stockDetails.material.sheetLength}x${stockDetails.material.sheetWidth}` : '-'}</p></div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className="text-ds-ink-muted">Physical Stock</span><p className={`${mono} text-ds-ink`}>{Math.max(0, (readiness?.availableSheets || 0) + (readiness?.reservedSheets || 0) + (readiness?.incomingSheets || 0)).toLocaleString('en-IN')}</p></div>
                    <div><span className="text-ds-ink-muted">Available</span><p className={`${mono} text-ds-ink`}>{Math.max(0, readiness?.availableSheets || 0).toLocaleString('en-IN')}</p></div>
                    <div><span className="text-ds-ink-muted">Reserved</span><p className={`${mono} text-ds-ink`}>{Math.max(0, readiness?.reservedSheets || 0).toLocaleString('en-IN')}</p></div>
                    <div><span className="text-ds-ink-muted">Incoming</span><p className={`${mono} text-ds-ink`}>{Math.max(0, readiness?.incomingSheets || 0).toLocaleString('en-IN')}</p></div>
                    <div><span className="text-ds-ink-muted">Shortage</span><p className={`${mono} text-ds-ink`}>{Math.max(0, readiness?.shortageSheets || 0).toLocaleString('en-IN')}</p></div>
                    <div><span className="text-ds-ink-muted">Free / Usable Stock</span><p className={`${mono} text-ds-ink`}>{Math.max(0, (readiness?.availableSheets || 0) - (readiness?.reservedSheets || 0)).toLocaleString('en-IN')}</p></div>
                  </div>
                  <div>
                    <p className="text-ds-ink-muted mb-1">Reserved by Jobs</p>
                    {(stockDetails.reservations || []).length === 0 ? <p className="text-ds-ink-faint">No active reservations.</p> : (
                      <ul className="space-y-1">
                        {stockDetails.reservations.slice(0, 5).map((r) => (
                          <li key={r.id} className="rounded border border-ds-line/30 px-2 py-1">
                            JC#{r.jobCard.jobCardNumber} · {r.cartonName || '-'} · {Number(r.reservedSheets).toLocaleString('en-IN')} sh · {r.status || '-'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p className="text-ds-ink-muted mb-1">Open Shortages</p>
                    {(stockDetails.shortages || []).length === 0 ? <p className="text-ds-ink-faint">No open shortages.</p> : (
                      <ul className="space-y-1">
                        {stockDetails.shortages.slice(0, 5).map((s) => (
                          <li key={s.id} className="rounded border border-ds-line/30 px-2 py-1">
                            {s.id} · JC#{s.jobCardNumber ?? '-'} · {Number(s.pendingShortage).toLocaleString('en-IN')} sh · {s.priority}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p className="text-ds-ink-muted mb-1">Recent Stock Logs</p>
                    {(stockDetails.logs || []).length === 0 ? <p className="text-ds-ink-faint">No stock logs.</p> : (
                      <ul className="space-y-1">
                        {stockDetails.logs.slice(0, 8).map((l) => (
                          <li key={l.id} className="rounded border border-ds-line/30 px-2 py-1">
                            {new Date(l.createdAt).toLocaleString('en-IN')} · {l.movementType} · {Number(l.qty).toLocaleString('en-IN')} · {l.refType || '-'} {l.refId ? `(${l.refId.slice(0, 8)})` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
              <Link
                href={(selectedMaterialId || readiness?.materialId)
                  ? `/inventory?materialId=${encodeURIComponent(selectedMaterialId || readiness?.materialId || '')}`
                  : `/inventory?ledgerBoard=${encodeURIComponent(readiness?.boardType || '')}&ledgerGsm=${encodeURIComponent(String(readiness?.gsm ?? ''))}`}
                className="text-xs font-medium text-ds-brand underline-offset-2 hover:underline"
              >
                Open Warehouse (optional)
              </Link>
            </div>
          ) : null}
        </CardSection>

        <CardSection title="Printing" id="plan-drawer-printing">
          <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="ds-typo-label">Coating</p>
              <PackagingEnumCombobox
                aria-label="Coating"
                options={coatingOptions}
                value={line.coatingType ?? line.carton?.coatingType ?? null}
                onChange={(v) => {
                  updateRow(line.id, { coatingType: v })
                  void onSaveLine(line.id, { coatingType: v })
                }}
                className="w-full"
                controlClassName={comboControl}
                inputClassName={comboInput}
              />
            </div>
            <div>
              <p className="ds-typo-label">Emboss / leafing</p>
              <PackagingEnumCombobox
                aria-label="Embossing"
                options={MASTER_EMBOSSING_AND_LEAFING}
                value={line.embossingLeafing}
                onChange={(v) => {
                  updateRow(line.id, { embossingLeafing: v })
                  void onSaveLine(line.id, { embossingLeafing: v })
                }}
                className="w-full"
                controlClassName={comboControl}
                inputClassName={comboInput}
              />
            </div>
            <div>
              <p className="ds-typo-label">Laminate</p>
              <PackagingEnumCombobox
                aria-label="Laminate"
                options={coatingOptions}
                value={line.otherCoating ?? line.carton?.laminateType ?? null}
                onChange={(v) => {
                  updateRow(line.id, { otherCoating: v })
                  void onSaveLine(line.id, { otherCoating: v })
                }}
                className="w-full"
                controlClassName={comboControl}
                inputClassName={comboInput}
              />
            </div>
            <label className="block">
              <span className="ds-typo-label">Foil</span>
              <input
                className={fieldInput}
                value={specFoil(line)}
                onChange={(e) => {
                  const v = e.target.value
                  const next = { ...spec, foilType: v || null } as Record<string, unknown>
                  updateRow(line.id, { specOverrides: next })
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  const next = { ...spec, foilType: v || null } as Record<string, unknown>
                  void onSaveLine(line.id, {}, next)
                }}
              />
            </label>
            <label className="block">
              <span className="ds-typo-label">Pasting</span>
              <input
                className={fieldInput}
                value={specPasting(line)}
                onChange={(e) => {
                  const v = e.target.value
                  const next = { ...spec, pastingType: v || null } as Record<string, unknown>
                  updateRow(line.id, { specOverrides: next })
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  const next = { ...spec, pastingType: v || null } as Record<string, unknown>
                  void onSaveLine(line.id, {}, next)
                }}
              />
            </label>
          </div>
        </CardSection>

        <CardSection title="Gang print" id="plan-drawer-gang-ups">
          <div id="placement-ref">
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="single-sheet-length" className="block text-xs font-medium text-ds-ink-muted">
                  Sheet length (mm)
                </label>
                <input
                  id="single-sheet-length"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="e.g. 720"
                  className={fieldInput}
                  value={sheetLengthMm}
                  onChange={(e) => setSheetLengthMm(e.target.value)}
                  onBlur={(e) => {
                    const specNow = (line.specOverrides || {}) as Record<string, unknown>
                    const value = e.target.value.trim()
                    const parsed = value === '' ? null : parseInt(value, 10)
                    const next = { ...specNow } as Record<string, unknown>
                    if (Number.isFinite(parsed) && (parsed as number) > 0) {
                      next.sheetLengthMm = parsed as number
                      setSheetLengthMm(String(parsed))
                    } else {
                      delete next.sheetLengthMm
                      setSheetLengthMm('')
                    }
                    updateRow(line.id, { specOverrides: next })
                    void onSaveLine(line.id, { specOverrides: next })
                  }}
                />
              </div>
              <div>
                <label htmlFor="single-sheet-width" className="block text-xs font-medium text-ds-ink-muted">
                  Sheet width (mm)
                </label>
                <input
                  id="single-sheet-width"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="e.g. 1020"
                  className={fieldInput}
                  value={sheetWidthMm}
                  onChange={(e) => setSheetWidthMm(e.target.value)}
                  onBlur={(e) => {
                    const specNow = (line.specOverrides || {}) as Record<string, unknown>
                    const value = e.target.value.trim()
                    const parsed = value === '' ? null : parseInt(value, 10)
                    const next = { ...specNow } as Record<string, unknown>
                    if (Number.isFinite(parsed) && (parsed as number) > 0) {
                      next.sheetWidthMm = parsed as number
                      setSheetWidthMm(String(parsed))
                    } else {
                      delete next.sheetWidthMm
                      setSheetWidthMm('')
                    }
                    updateRow(line.id, { specOverrides: next })
                    void onSaveLine(line.id, { specOverrides: next })
                  }}
                />
              </div>
            </div>
            <div id="fix-ups-render" className="space-y-1.5">
            <label htmlFor="ups-input" id="label" className="block text-xs font-medium text-ds-ink-muted">
              Ups (per plate/output)
            </label>
            <div id="fix-ups-save">
              <input
                id="ups-input"
                data-fix-ups-binding
                type="number"
                min={1}
                step={1}
                placeholder="Enter ups"
                className={`${fieldInput} max-w-[8rem] ${gangUpsStr ? 'border-ds-success/50 bg-ds-success/10' : ''}`}
                value={gangUpsStr}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  if (v === '') {
                    const next = mergePlanningMetaUps(spec, null)
                    updateRow(line.id, { specOverrides: next })
                    return
                  }
                  const n = parseInt(v, 10)
                  if (!Number.isFinite(n) || n < 1) return
                  const next = mergePlanningMetaUps(spec, n)
                  updateRow(line.id, { specOverrides: next })
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  const n = v === '' ? null : parseInt(v, 10)
                  const next =
                    Number.isFinite(n) && (n as number) >= 1
                      ? mergePlanningMetaUps(spec, n as number)
                      : mergePlanningMetaUps(spec, null)
                  updateRow(line.id, { specOverrides: next })
                  void onSaveLine(line.id, { specOverrides: next })
                }}
              />
            </div>
            <p id="helper" className="text-xs text-ds-ink-faint">
              No. of repeats of this product in one gang layout
            </p>
            </div>
          </div>
        </CardSection>

        <CardSection title="Costing" id="plan-drawer-costing" className="border-ds-success/25 bg-ds-elevated/40">
          <div className="space-y-4">
            <div>
              <p className="ds-typo-label">Rate (per unit, ex-GST)</p>
              <input
                type="number"
                min={0}
                step="0.01"
                className={`${fieldInput} ${mono} text-ds-ink-muted`}
                value={line.rate != null ? String(line.rate) : ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '') {
                    updateRow(line.id, { rate: null })
                    return
                  }
                  const n = parseFloat(v)
                  if (Number.isFinite(n)) updateRow(line.id, { rate: n })
                }}
                onBlur={() => void onSaveLine(line.id, { rate: line.rate ?? null })}
              />
            </div>
            <div className="rounded-ds-md border border-ds-success/30 bg-ds-success/5 p-4 md:p-5">
              <p className="text-xs font-medium text-ds-ink-muted">Line amount (ex-GST)</p>
              <p className="mt-2 text-2xl font-bold leading-tight text-ds-success tabular-nums md:text-2xl">
                ₹ {amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
            {line.cartonId ? (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={saveMasterBusy}
                onClick={() => void saveToProductMaster()}
              >
                {saveMasterBusy ? 'Saving to master…' : 'Save to product master'}
              </Button>
            ) : null}
            <div>
              <Button type="button" variant="ghost" className="h-auto px-0 py-1 text-xs" onClick={() => setSplitOpen((o) => !o)}>
                {splitOpen ? 'Hide split' : 'Split (intent)'}
              </Button>
              {splitOpen ? (
                <div className="mt-2 space-y-2 rounded-ds-md border border-ds-line/60 bg-ds-elevated/30 p-3">
                  <p className="text-xs leading-snug text-ds-ink-faint">Notional split — coordinate with Accounts for PO changes.</p>
                  <label className="ds-typo-label block">First job qty</label>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(0, totalQty - 1)}
                    value={splitA === '' ? '' : splitA}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '') {
                        setSplitA('')
                        return
                      }
                      const n = parseInt(v, 10)
                      if (Number.isFinite(n)) setSplitA(n)
                    }}
                    className="ds-input w-full text-sm"
                  />
                  {splitB != null ? (
                    <p className={`text-xs text-ds-ink-muted ${mono}`}>
                      Second: <span className="font-medium text-ds-ink">{splitB}</span>
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full text-xs"
                    onClick={() => {
                      if (splitB == null || typeof splitA !== 'number') {
                        toast.error('Enter a valid split (1 … total − 1).')
                        return
                      }
                      toast.success(
                        `Intent: ${splitA} + ${splitB} = ${totalQty}. Follow up in Accounts to adjust the PO if needed.`,
                      )
                      setSplitOpen(false)
                      setSplitA('')
                    }}
                  >
                    Confirm split intent
                  </Button>
                </div>
              ) : null}
            </div>
            <div>
              <p className="ds-typo-label">Remarks</p>
              <textarea
                value={remarksDraft}
                onChange={(e) => setRemarksDraft(e.target.value)}
                rows={3}
                className="ds-input min-h-[5rem] w-full resize-y text-sm"
                placeholder="Internal notes"
              />
            </div>
          </div>
        </CardSection>

        <div className="space-y-2 border-t border-ds-line/50 pt-6">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={actionBusy}
            onClick={handleAddToBatch}
          >
            <Layers className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Add to group
          </Button>
          <Button type="button" variant="secondary" className="w-full" disabled={actionBusy} onClick={handleHold}>
            <PauseCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {line.directorHold ? 'Release hold' : 'Hold'}
          </Button>
          <Button type="button" variant="secondary" className="w-full" disabled={actionBusy} onClick={handlePriority}>
            <Star className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {line.directorPriority ? 'Clear priority' : 'Priority'}
          </Button>
        </div>
      </div>
      <StandardDrawer
        isOpen={suggestionsWorkspaceOpen}
        onClose={() => setSuggestionsWorkspaceOpen(false)}
        title="Suggestion Workspace"
        metadata={<p className="text-xs text-ds-ink-faint">Extended view for material decision and safer mapping verification.</p>}
        primaryAction={{
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
            <table className="w-full min-w-[860px] table-auto text-left">
              <thead className="bg-ds-elevated/30 text-[11px] uppercase tracking-wide text-ds-ink-faint">
                <tr>
                  <th className="px-2 py-2">Material</th>
                  <th className="px-2 py-2">Parent Size</th>
                  <th className="px-2 py-2">GSM</th>
                  <th className="px-2 py-2">Cuts</th>
                  <th className="px-2 py-2">Req Parent</th>
                  <th className="px-2 py-2">Available</th>
                  <th className="px-2 py-2">Yield/Waste</th>
                  <th className="px-2 py-2">Match</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {((((readiness?.suggestedBoardOptions?.length || 0) > 0
                  ? readiness?.suggestedBoardOptions
                  : readiness?.closestAvailableOptions) || [])).slice(0, 10).map((opt) => (
                  <tr key={`ws-${opt.materialId}`} className="border-t border-ds-line/30">
                    <td className="px-2 py-2">
                      <p className={mono}>{opt.materialCode}</p>
                      <p className="text-ds-ink-faint">{opt.boardType || '-'} / {opt.boardClassification || '-'}</p>
                    </td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.size}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.gsm ?? '-'}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.cutsPerSheet}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.requiredParentSheets}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.availableSheets}</td>
                    <td className={`px-2 py-2 ${mono}`}>{opt.yieldPct}% / {opt.wastagePct}%</td>
                    <td className="px-2 py-2">
                      <span>{opt.matchType}</span>
                      <span className="ml-1 text-ds-ink-faint">({opt.boardMatchMode === 'exact' ? 'Board exact' : opt.boardMatchMode === 'cross_field' ? 'Board mapped' : 'Board fallback'})</span>
                    </td>
                    <td className="px-2 py-2">{opt.status}</td>
                    <td className="px-2 py-2">
                      <Button
                        type="button"
                        disabled={reserveBusy}
                        onClick={() => void handleReserveMaterial(opt.materialId, opt.cutsPerSheet, opt.size)}
                        className="h-7 px-2 text-xs"
                      >
                        {reserveBusy && selectedMaterialId === opt.materialId ? 'Reserving…' : 'Select & Reserve'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </StandardDrawer>
    </StandardDrawer>
  )
}
