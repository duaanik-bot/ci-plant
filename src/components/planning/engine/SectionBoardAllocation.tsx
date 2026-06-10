'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningMeta, mergePlanningMetaUps, mergePlanningMetaSheetSpec } from '@/lib/planning-decision-spec'
import { resolveUps } from '@/lib/production-os-resolvers'
import { resolveSheetSize as resolveSheetSizeFromLine } from '@/lib/planning-sheet-size'
import {
  computeEqualDivisionFit,
  parseSheetDims,
  pickPreferredParentSheetMatch,
  type CutType,
  type ParentSheetCandidate,
} from '@/lib/smart-match-parent-sheets'
import type { PlanningEngineBoardOption, PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'
import { getPlanningRequirement } from './planningRequirement'

export type CartonMasterPatch = {
  sheetSizeL?: number | null
  sheetSizeW?: number | null
  ups?: number | null
}

export type StockSearchResult = {
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  size: string | null
  freeSheets: number
  reservedSheets: number
  storageLocation: string | null
  supplierName: string | null
  lot: string | null
}

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  readinessLoading: boolean
  onPatch: SectionPatchFn
  /** Link the line to a board material (same path Smart Match uses). */
  onSelectBoard?: (materialId: string, cutsPerSheet?: number, parentSize?: string, cutType?: number) => Promise<void>
  /** Persist sheet length/width/UPS back onto the carton master (values in inches). */
  onSaveCartonMaster?: (patch: CartonMasterPatch) => Promise<void>
  /** Called when planner clicks Reserve — parent wires to POST reserve-material. */
  onReserve?: () => Promise<void>
  /** Called when planner clicks Unreserve (full or partial) — parent wires to POST reservation-control release. */
  onUnreserve?: (qty?: number) => Promise<void>
  /** Called when planner clicks Raise PR — parent wires to PR creation. */
  onRaisePR?: () => Promise<void>
  /** Called to search warehouse stock by query — returns matching materials. */
  onStockSearch?: (q: string) => Promise<StockSearchResult[]>
  /** Shares the in-progress Units per sheet draft with calculation summary. */
  onDraftUnitsPerSheetChange?: (value: string | null) => void
  /** Shares the in-progress Cut type draft with cut-plan Qty per Sheet. */
  onDraftCutTypeChange?: (value: string | null) => void
}

// ─── Formatters ───────────────────────────────────────────────────────────────
const nf = new Intl.NumberFormat('en-IN')

function formatSheets(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${nf.format(Math.round(n))} sh`
}

function hasText(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

// ─── Pure resolvers ────────────────────────────────────────────────────────────
/** Board type the engine wants to commit: the line's own value first, then the matched material / queue / carton. */
function resolveBoardType(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): string {
  return (
    (hasText(line.paperType) ? (line.paperType as string) : '') ||
    readiness?.boardType ||
    line.materialQueue?.boardType ||
    line.carton?.paperType ||
    ''
  ).trim()
}

function resolveGsm(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): number | null {
  const gsm = line.gsm ?? readiness?.gsm ?? line.carton?.gsm ?? null
  return gsm != null && Number.isFinite(gsm) ? gsm : null
}

/** Parent board sheet size — saved value (meta.parentSize) first, then readiness label, then queue dims. */
function resolveSheetSize(line: PlanningEngineLine, readiness: PlanningEngineReadiness | null): string {
  const m = readPlanningMeta(line.specOverrides ?? null)
  if (hasText(m.parentSize)) return (m.parentSize as string).trim().replace(/x/gi, '×')
  if (readiness?.size) return readiness.size
  const fromLine = resolveSheetSizeFromLine({
    specOverrides: line.specOverrides ?? null,
    carton: (line.carton ?? null) as Record<string, unknown> | null,
    materialQueue: (line.materialQueue ?? null) as Record<string, unknown> | null,
  })
  if (fromLine && fromLine !== '-') return fromLine.replace(/x/gi, '×')
  return ''
}

function metaParentSizeSet(spec: Record<string, unknown>, size: string | null): Record<string, unknown> {
  const meta = { ...readPlanningMeta(spec) }
  const v = (size ?? '').trim()
  if (v) meta.parentSize = v
  else delete meta.parentSize
  const next = { ...spec }
  if (Object.keys(meta).length === 0) delete next.meta
  else next.meta = meta
  return next
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseDims(size: string | null | undefined): { l: number | null; w: number | null } {
  if (!size) return { l: null, w: null }
  const m = String(size).match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i)
  return m ? { l: Number(m[1]), w: Number(m[2]) } : { l: null, w: null }
}

const IN_TO_MM = 25.4
function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Round to 2 decimals so unit conversion never leaks float drift into stored values. */
function round2(n: number | null): number | null {
  return n == null ? null : Math.round(n * 100) / 100
}

/** A sheet dimension typed in the active unit → inches (the canonical master unit). */
function toInches(value: number | null, unit: 'mm' | 'inch'): number | null {
  if (value == null) return null
  return unit === 'mm' ? round2(value / IN_TO_MM) : value
}

function toStoredMm(value: number | null, unit: 'mm' | 'inch'): number {
  if (value == null) return 0
  return unit === 'inch' ? value * IN_TO_MM : value
}

function fromStoredMm(value: number | null, unit: 'mm' | 'inch'): number | null {
  if (value == null) return null
  return unit === 'inch' ? round2(value / IN_TO_MM) : value
}

function inferSizeUnit(length: number, width: number): 'mm' | 'inch' {
  return Math.max(length, width) > 200 ? 'mm' : 'inch'
}

function convertDimension(value: number, from: 'mm' | 'inch', to: 'mm' | 'inch'): number {
  if (from === to) return value
  return from === 'inch' ? value * IN_TO_MM : value / IN_TO_MM
}

function computeAutoUpsFromFit(args: {
  parentSize: string
  childLength: number | null
  childWidth: number | null
  childUnit: 'mm' | 'inch'
  cutType: number | null
}): number | null {
  const parent = parseSheetDims(args.parentSize)
  const cutType = Math.max(1, Math.min(6, Math.floor(Number(args.cutType ?? 0))))
  if (!parent || !(args.childLength && args.childWidth) || !(cutType > 0)) return null
  const parentUnit = inferSizeUnit(parent.length, parent.width)
  const childLength = convertDimension(args.childLength, args.childUnit, parentUnit)
  const childWidth = convertDimension(args.childWidth, args.childUnit, parentUnit)
  const fit = computeEqualDivisionFit({
    parentLength: parent.length,
    parentWidth: parent.width,
    childLength,
    childWidth,
    cutType: cutType as CutType,
    allowRotation: true,
  })
  return fit.qualifies && fit.piecesPerSheet > 0 ? fit.piecesPerSheet : null
}

function toParentSheetCandidate(option: PlanningEngineBoardOption): ParentSheetCandidate {
  return {
    materialId: option.materialId,
    materialCode: option.materialCode,
    boardType: option.boardType,
    gsm: option.gsm,
    size: option.size,
    freeSheets: option.freeSheets,
    availableSheets: option.availableSheets,
    gsmDelta: option.gsmDelta,
  }
}

function normalizeSizeLabel(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, '').replace(/[xX]/g, '×').toLowerCase()
}

function formatDraftNumber(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return ''
  return String(Number(value.toFixed(4)))
}

// ─── Sub-components ───────────────────────────────────────────────────────────
const EditableTile = memo(function EditableTile({
  label,
  value,
  onChange,
  onCommit,
  type = 'text',
  placeholder,
  ariaLabel,
  badge,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  type?: 'text' | 'number'
  placeholder?: string
  ariaLabel: string
  badge?: React.ReactNode
}) {
  return (
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
        {badge}
      </div>
      <input
        type="text"
        inputMode={type === 'number' ? 'decimal' : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        aria-label={ariaLabel}
        className="w-full bg-transparent text-base font-semibold text-ds-ink outline-none leading-tight tabular-nums placeholder:text-ds-ink-faint/60"
      />
    </div>
  )
})

const ReadOnlyTile = memo(function ReadOnlyTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className="text-base font-semibold text-ds-ink leading-tight mt-1">{value}</div>
    </div>
  )
})

/** Warehouse stock bar — visualises free / reserved / incoming vs required. */
const WarehouseStrip = memo(function WarehouseStrip({
  free,
  reserved,
  incoming,
  required,
}: {
  free: number
  reserved: number
  incoming: number
  required: number
}) {
  const total = Math.max(1, free + reserved + incoming)
  const freePct = Math.min(100, Math.round((free / total) * 100))
  const resPct = Math.min(100, Math.round((reserved / total) * 100))
  const incPct = Math.min(100, Math.round((incoming / total) * 100))
  const needPct = Math.min(100, Math.round((required / total) * 100))

  return (
    <div className="mt-3 rounded-ds-md border border-ds-line/40 bg-ds-elevated/60 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-2">
        Warehouse snapshot
      </div>
      {/* Stacked stock bar */}
      <div className="relative h-3 rounded-full bg-ds-main/60 overflow-hidden mb-2.5">
        <div className="absolute left-0 top-0 h-full bg-emerald-500/60 rounded-full" style={{ width: `${freePct}%` }} />
        <div
          className="absolute top-0 h-full bg-amber-500/60"
          style={{ left: `${freePct}%`, width: `${resPct}%` }}
        />
        {incoming > 0 ? (
          <div
            className="absolute top-0 h-full bg-blue-500/40"
            style={{ left: `${freePct + resPct}%`, width: `${incPct}%` }}
          />
        ) : null}
        {/* Required marker */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white/60"
          style={{ left: `${needPct}%` }}
          title={`Required: ${nf.format(Math.round(required))} sh`}
        />
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500/70" />
          <span className="text-ds-ink-faint">Free</span>
          <span className="font-semibold text-emerald-300">{formatSheets(free)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500/70" />
          <span className="text-ds-ink-faint">Reserved</span>
          <span className="font-semibold text-ds-ink">{formatSheets(reserved)}</span>
        </span>
        {incoming > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-blue-500/50" />
            <span className="text-ds-ink-faint">Incoming</span>
            <span className="font-semibold text-blue-300">{formatSheets(incoming)}</span>
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="inline-block h-2 w-0.5 bg-white/50" />
          <span className="text-ds-ink-faint">Required</span>
          <span className="font-semibold text-ds-ink">{formatSheets(required)}</span>
        </span>
      </div>
    </div>
  )
})

// ─── Main component ───────────────────────────────────────────────────────────
const WASTAGE_DEFAULT = 150

export const SectionBoardAllocation = memo(function SectionBoardAllocation({
  line,
  readiness,
  readinessLoading,
  onPatch,
  onSelectBoard,
  onSaveCartonMaster,
  onStockSearch,
  onDraftUnitsPerSheetChange,
  onDraftCutTypeChange,
}: Props) {
  const required = Number(
    readiness?.requiredSheets ?? line.planningLedger?.boardStockInsight?.requiredSheets ?? 0,
  )
  const netStock = Number(
    readiness?.availableSheets ?? line.planningLedger?.boardStockInsight?.availableTotalSheets ?? 0,
  )
  const reserved = Number(
    readiness?.reservedSheets ?? line.planningLedger?.boardStockInsight?.reservedSheets ?? 0,
  )
  const incoming = Number(readiness?.incomingSheets ?? 0)

  // ── Memoised spec & resolved values ─────────────────────────────────────────
  const spec = useMemo(
    () => (line.specOverrides ?? {}) as Record<string, unknown>,
    [line.specOverrides],
  )
  const meta = useMemo(() => readPlanningMeta(spec), [spec])
  const upsManual = meta?.upsSource === 'manual' || meta?.upsEdited === true

  const resolvedBoardType = useMemo(() => resolveBoardType(line, readiness), [line, readiness])
  const resolvedGsm = useMemo(() => resolveGsm(line, readiness), [line, readiness])
  const resolvedSheetSize = useMemo(() => resolveSheetSize(line, readiness), [line, readiness])

  // Default display unit is inches; a per-line override or saved meta unit wins.
  const resolvedUnit = (line.sheetSpec?.unit ?? (meta.sheetUnit as 'mm' | 'inch') ?? 'inch') as 'mm' | 'inch'

  // Carton (product) master sheet size — stored in inches; shown in the active unit.
  const cartonLengthIn = numOrNull(line.carton?.sheetSizeL)
  const cartonWidthIn = numOrNull(line.carton?.sheetSizeW)

  const mq = (line.materialQueue ?? null) as { sheetLengthMm?: unknown; sheetWidthMm?: unknown } | null
  const parsedDims = useMemo(() => parseDims(resolvedSheetSize), [resolvedSheetSize])
  const resolvedLength = useMemo(() => {
    const fromMeta = Number(meta.sheetLengthMm)
    if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta
    const fromSpec = fromStoredMm(numOrNull(line.sheetSpec?.lengthMm), resolvedUnit)
    if (fromSpec != null) return fromSpec
    if (cartonLengthIn != null) return resolvedUnit === 'mm' ? Math.round(cartonLengthIn * IN_TO_MM) : cartonLengthIn
    if (parsedDims.l != null) return parsedDims.l
    return fromStoredMm(numOrNull(mq?.sheetLengthMm), resolvedUnit)
  }, [meta.sheetLengthMm, line.sheetSpec?.lengthMm, resolvedUnit, cartonLengthIn, parsedDims.l, mq?.sheetLengthMm])
  const resolvedWidth = useMemo(() => {
    const fromMeta = Number(meta.sheetWidthMm)
    if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta
    const fromSpec = fromStoredMm(numOrNull(line.sheetSpec?.widthMm), resolvedUnit)
    if (fromSpec != null) return fromSpec
    if (cartonWidthIn != null) return resolvedUnit === 'mm' ? Math.round(cartonWidthIn * IN_TO_MM) : cartonWidthIn
    if (parsedDims.w != null) return parsedDims.w
    return fromStoredMm(numOrNull(mq?.sheetWidthMm), resolvedUnit)
  }, [meta.sheetWidthMm, line.sheetSpec?.widthMm, resolvedUnit, cartonWidthIn, parsedDims.w, mq?.sheetWidthMm])
  const savedMetaCutType = Number(meta.cutType)
  const savedLegacyCutType = Number(meta.cutsPerSheet)
  const explicitCutType =
    line.sheetSpec?.cutType ??
    (Number.isFinite(savedMetaCutType) && savedMetaCutType >= 1 && savedMetaCutType <= 6
      ? savedMetaCutType
      : Number.isFinite(savedLegacyCutType) && savedLegacyCutType >= 1 && savedLegacyCutType <= 6
        ? savedLegacyCutType
        : null)
  const inventoryCandidates = useMemo<ParentSheetCandidate[]>(() => {
    const merged = new Map<string, ParentSheetCandidate>()
    for (const option of [...(readiness?.suggestedBoardOptions ?? []), ...(readiness?.closestAvailableOptions ?? [])]) {
      if (!merged.has(option.materialId)) merged.set(option.materialId, toParentSheetCandidate(option))
    }
    return Array.from(merged.values())
  }, [readiness?.suggestedBoardOptions, readiness?.closestAvailableOptions])
  const preferredCutMatch = useMemo(() => {
    if (explicitCutType != null || !(resolvedLength && resolvedWidth) || inventoryCandidates.length === 0) return null
    return pickPreferredParentSheetMatch({
      childLength: resolvedLength,
      childWidth: resolvedWidth,
      requiredQty: line.quantity || readiness?.requiredSheets || 1,
      unit: resolvedUnit,
      boardType: resolvedBoardType || null,
      gsm: resolvedGsm,
      candidates: inventoryCandidates,
    })
  }, [
    explicitCutType,
    resolvedLength,
    resolvedWidth,
    inventoryCandidates,
    readiness?.requiredSheets,
    line.quantity,
    resolvedUnit,
    resolvedBoardType,
    resolvedGsm,
  ])
  const resolvedCutType = explicitCutType ?? preferredCutMatch?.cutType ?? null
  const selectedMaterialSaved = hasText((spec as Record<string, unknown>).planningMaterialId)
  const parentSizeCanAutoUpdate =
    !selectedMaterialSaved &&
    (!hasText(meta.parentSize) || normalizeSizeLabel(meta.parentSize) === normalizeSizeLabel(readiness?.size))
  const effectiveParentSize =
    parentSizeCanAutoUpdate && preferredCutMatch?.parentSize ? preferredCutMatch.parentSize : resolvedSheetSize
  const autoFitUps = useMemo(
    () =>
      computeAutoUpsFromFit({
        parentSize: effectiveParentSize,
        childLength: resolvedLength,
        childWidth: resolvedWidth,
        childUnit: resolvedUnit,
        cutType: resolvedCutType,
      }),
    [effectiveParentSize, resolvedLength, resolvedWidth, resolvedUnit, resolvedCutType],
  )
  const upsEdited = meta.upsEdited === true || meta.upsSource === 'manual'
  const selectedCutUps = Number(meta.selectedCutsPerSheet ?? meta.cutsPerSheet)
  const resolvedUps = useMemo(
    () =>
      (upsEdited
        ? (resolveUps(line) ?? autoFitUps ?? resolvedCutType ?? null)
        : selectedMaterialSaved && Number.isFinite(selectedCutUps) && selectedCutUps > 0
          ? Math.floor(selectedCutUps)
          : (autoFitUps ?? resolvedCutType ?? resolveUps(line) ?? null)) as number | null,
    [selectedMaterialSaved, selectedCutUps, upsEdited, line, autoFitUps, resolvedCutType],
  )

  const wastageFromSpec = useMemo(
    () => (spec.wastageSheets != null ? Number(spec.wastageSheets) : WASTAGE_DEFAULT),
    [spec],
  )

  const requirement = getPlanningRequirement(line, {
    unitsPerSheet: resolvedUps,
    wastageSheets: wastageFromSpec,
  })
  const baseSheets = requirement.baseSheets
  const totalRequired = requirement.totalRequired ?? required ?? null

  // ── SINGLE combined state — one setState = one re-render ──────────────────
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const isEditingInside = useCallback(() => {
    const active = document.activeElement
    return (
      active instanceof HTMLElement &&
      sectionRef.current?.contains(active) === true &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')
    )
  }, [])

  const [drafts, setDrafts] = useState({
    poQty: requirement.totalPoQty > 0 ? String(Math.round(requirement.totalPoQty)) : '',
    board: resolvedBoardType,
    gsm: resolvedGsm != null ? String(resolvedGsm) : '',
    sheetLength: formatDraftNumber(resolvedLength),
    sheetWidth: formatDraftNumber(resolvedWidth),
    sheetUnit: resolvedUnit,
    cutType: resolvedCutType != null ? String(resolvedCutType) : '',
    ups: resolvedUps != null ? String(resolvedUps) : '',
    wastage: String(wastageFromSpec),
  })

  // ONE effect replaces the previous four — fires when any resolved value changes
  useEffect(() => {
    if (isEditingInside()) return
    setDrafts({
      poQty: requirement.totalPoQty > 0 ? String(Math.round(requirement.totalPoQty)) : '',
      board: resolvedBoardType,
      gsm: resolvedGsm != null ? String(resolvedGsm) : '',
      sheetLength: formatDraftNumber(resolvedLength),
      sheetWidth: formatDraftNumber(resolvedWidth),
      sheetUnit: resolvedUnit,
      cutType: resolvedCutType != null ? String(resolvedCutType) : '',
      ups: resolvedUps != null ? String(resolvedUps) : '',
      wastage: String(wastageFromSpec),
    })
  }, [requirement.totalPoQty, resolvedBoardType, resolvedGsm, resolvedLength, resolvedWidth, resolvedUnit, resolvedCutType, resolvedUps, wastageFromSpec, isEditingInside])

  useEffect(() => {
    onDraftUnitsPerSheetChange?.(resolvedUps != null ? String(resolvedUps) : null)
  }, [line.id, onDraftUnitsPerSheetChange, resolvedUps])

  useEffect(() => {
    onDraftCutTypeChange?.(resolvedCutType != null ? String(resolvedCutType) : null)
  }, [line.id, onDraftCutTypeChange, resolvedCutType])

  // Backfill — commit auto-populated values onto the line whenever the selected
  // parent / auto yield changes. Fill-empty/manual-safe: never overwrites a
  // planner-entered UPS.
  const backfilledRef = useRef<string | null>(null)
  useEffect(() => {
    if (readinessLoading) return
    if (isEditingInside()) return
    const signature = `${line.id}:${effectiveParentSize}:${resolvedCutType ?? ''}:${resolvedUps ?? ''}:${upsEdited ? 'manual' : 'auto'}`
    if (!line.id || backfilledRef.current === signature) return
    backfilledRef.current = signature

    const patch: Parameters<SectionPatchFn>[0] = {}
    if (!hasText(line.paperType) && resolvedBoardType) patch.paperType = resolvedBoardType
    if (line.gsm == null && resolvedGsm != null) patch.gsm = resolvedGsm

    let s = { ...spec }
    let specChanged = false
    const m = readPlanningMeta(s)
    if (!hasText(m.parentSize) && effectiveParentSize) {
      s = metaParentSizeSet(s, effectiveParentSize)
      specChanged = true
    }
    if (parentSizeCanAutoUpdate && effectiveParentSize && normalizeSizeLabel(m.parentSize) !== normalizeSizeLabel(effectiveParentSize)) {
      s = metaParentSizeSet(s, effectiveParentSize)
      specChanged = true
    }
    if (explicitCutType == null && resolvedCutType != null && Number(m.cutType) !== resolvedCutType) {
      s = mergePlanningMetaSheetSpec(s, {
        lengthMm: resolvedLength,
        widthMm: resolvedWidth,
        unit: resolvedUnit,
        cutType: resolvedCutType,
      })
      specChanged = true
    }
    if (!upsEdited && resolvedUps != null && m.ups !== resolvedUps) {
      s = mergePlanningMetaUps(s, resolvedUps)
      const nextMeta: Record<string, unknown> = { ...readPlanningMeta(s), upsEdited: false }
      if (resolvedLength != null && resolvedWidth != null && resolvedCutType != null) {
        nextMeta.cutPlanChildSizes = [{
          lMm: toStoredMm(resolvedLength, resolvedUnit),
          wMm: toStoredMm(resolvedWidth, resolvedUnit),
          qty: resolvedUps,
        }]
        nextMeta.cutPlanAutoSignature = `${resolvedUnit}:${resolvedLength}x${resolvedWidth}:${resolvedCutType}`
        nextMeta.cutPlanEdited = false
        nextMeta.childInputLengthMm = toStoredMm(resolvedLength, resolvedUnit)
        nextMeta.childInputWidthMm = toStoredMm(resolvedWidth, resolvedUnit)
        nextMeta.cutsPerSheet = resolvedUps
        nextMeta.selectedCutsPerSheet = resolvedUps
      }
      s = { ...s, meta: nextMeta }
      specChanged = true
    }
    if (specChanged) patch.specOverrides = s
    if (Object.keys(patch).length > 0) void onPatch(patch)
  }, [
    line.id,
    line.paperType,
    line.gsm,
    readinessLoading,
    resolvedBoardType,
    resolvedGsm,
    effectiveParentSize,
    resolvedCutType,
    resolvedUps,
    upsEdited,
    explicitCutType,
    parentSizeCanAutoUpdate,
    resolvedLength,
    resolvedWidth,
    resolvedUnit,
    onPatch,
    spec,
    isEditingInside,
  ])

  // ── Commit handlers ───────────────────────────────────────────────────────
  const commitBoardType = useCallback(() => {
    const v = drafts.board.trim()
    if (v === (line.paperType ?? '').trim()) return
    void onPatch({ paperType: v || null })
  }, [drafts.board, line.paperType, onPatch])

  const commitPoQty = useCallback(() => {
    const next = drafts.poQty.trim() === '' ? 0 : Math.max(0, Math.round(Number(drafts.poQty) || 0))
    if (next === Math.round(Number(line.quantity ?? 0))) return
    void onPatch({ quantity: next })
  }, [drafts.poQty, line.quantity, onPatch])

  const commitGsm = useCallback(() => {
    const v = drafts.gsm.trim() === '' ? null : Math.max(1, Math.round(Number(drafts.gsm) || 0))
    if (v === (line.gsm ?? null)) return
    void onPatch({ gsm: v })
  }, [drafts.gsm, line.gsm, onPatch])

  const patchSheetSpecFromDrafts = useCallback((override?: Partial<typeof drafts>) => {
    const nextDrafts = { ...drafts, ...(override ?? {}) }
    const lengthMm = nextDrafts.sheetLength.trim() === '' ? null : Math.max(0.01, Number(nextDrafts.sheetLength) || 0)
    const widthMm = nextDrafts.sheetWidth.trim() === '' ? null : Math.max(0.01, Number(nextDrafts.sheetWidth) || 0)
    const cutType = nextDrafts.cutType.trim() === '' ? null : Math.max(1, Math.min(6, Math.round(Number(nextDrafts.cutType) || 0)))
    const unit = (nextDrafts.sheetUnit === 'inch' ? 'inch' : 'mm') as 'mm' | 'inch'
    const nextSpec = mergePlanningMetaSheetSpec({ ...spec }, { lengthMm, widthMm, unit, cutType })
    const nextMeta = { ...readPlanningMeta(nextSpec) }
    const parentSize = readiness?.size || (hasText(meta.parentSize) ? String(meta.parentSize) : resolvedSheetSize)
    if (parentSize) nextMeta.parentSize = parentSize
    if (lengthMm != null && widthMm != null && cutType != null) {
      const childL = toStoredMm(lengthMm, unit)
      const childW = toStoredMm(widthMm, unit)
      const fitUps = computeAutoUpsFromFit({
        parentSize,
        childLength: lengthMm,
        childWidth: widthMm,
        childUnit: unit,
        cutType,
      }) ?? cutType
      nextMeta.cutPlanChildSizes = [{ lMm: childL, wMm: childW, qty: fitUps }]
      nextMeta.cutPlanAutoSignature = `${unit}:${lengthMm}x${widthMm}:${cutType}`
      nextMeta.cutPlanEdited = false
      nextMeta.childInputLengthMm = childL
      nextMeta.childInputWidthMm = childW
      nextMeta.cutsPerSheet = fitUps
      nextMeta.selectedCutsPerSheet = fitUps
      nextMeta.ups = fitUps
      nextMeta.upsEdited = false
    }
    void onPatch({ specOverrides: { ...nextSpec, meta: nextMeta } })

    // Persist sheet size back onto the carton master (canonical unit = inches),
    // but only the dimensions that actually changed.
    const lengthIn = toInches(lengthMm, unit)
    const widthIn = toInches(widthMm, unit)
    const masterPatch: CartonMasterPatch = {}
    if (lengthIn !== cartonLengthIn) masterPatch.sheetSizeL = lengthIn
    if (widthIn !== cartonWidthIn) masterPatch.sheetSizeW = widthIn
    if (Object.keys(masterPatch).length > 0) void onSaveCartonMaster?.(masterPatch)
  }, [drafts, spec, onPatch, onSaveCartonMaster, cartonLengthIn, cartonWidthIn, readiness?.size, meta.parentSize, resolvedSheetSize])

  const commitSheetSpec = useCallback(() => {
    patchSheetSpecFromDrafts()
  }, [patchSheetSpecFromDrafts])

  const commitUps = useCallback(() => {
    const next = drafts.ups.trim() === '' ? null : Math.max(1, Math.floor(Number(drafts.ups) || 0))
    if (next === resolvedUps) return
    const nextSpec = mergePlanningMetaUps(spec, next)
    const nextMeta = {
      ...readPlanningMeta(nextSpec),
      ...(next != null ? { cutsPerSheet: next, selectedCutsPerSheet: next } : {}),
      upsEdited: true,
      upsSource: 'manual',
    }
    void onPatch({ specOverrides: { ...nextSpec, meta: nextMeta } })
    void onSaveCartonMaster?.({ ups: next })
  }, [drafts.ups, resolvedUps, spec, onPatch, onSaveCartonMaster])

  const commitWastage = useCallback(() => {
    const next =
      drafts.wastage.trim() === ''
        ? WASTAGE_DEFAULT
        : Math.max(0, Math.round(Number(drafts.wastage) || 0))
    if (next === wastageFromSpec) return
    void onPatch({ specOverrides: { ...spec, wastageSheets: next } })
  }, [drafts.wastage, wastageFromSpec, spec, onPatch])

  // ── Stock-search state ────────────────────────────────────────────────────
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [cutTypeOpen, setCutTypeOpen] = useState(false)
  const cutTypeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!onStockSearch || searchTerm.length < 2) {
      setSearchResults([])
      return
    }
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const results = await onStockSearch(searchTerm)
        setSearchResults(results)
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [searchTerm, onStockSearch])

  const selectCutType = useCallback((value: string) => {
    setDrafts((d) => ({ ...d, cutType: value }))
    onDraftCutTypeChange?.(value)
    patchSheetSpecFromDrafts({ cutType: value })
    setCutTypeOpen(false)
  }, [onDraftCutTypeChange, patchSheetSpecFromDrafts])

  useEffect(() => {
    if (!cutTypeOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (cutTypeRef.current?.contains(event.target as Node)) return
      setCutTypeOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCutTypeOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [cutTypeOpen])

  const selectSearchMaterial = useCallback((r: StockSearchResult) => {
    const parentSize = r.size || effectiveParentSize || resolvedSheetSize
    const cutType = resolvedCutType ?? null
    const cutsPerSheet =
      parentSize && cutType != null
        ? computeAutoUpsFromFit({
            parentSize,
            childLength: resolvedLength,
            childWidth: resolvedWidth,
            childUnit: resolvedUnit,
            cutType,
          }) ?? resolvedUps ?? cutType
        : resolvedUps ?? undefined
    void onSelectBoard?.(
      r.materialId,
      cutsPerSheet ?? undefined,
      parentSize || undefined,
      cutType ?? undefined,
    )
    setSearchTerm('')
    setSearchResults([])
  }, [effectiveParentSize, onSelectBoard, resolvedCutType, resolvedLength, resolvedSheetSize, resolvedUnit, resolvedUps, resolvedWidth])

  return (
    <div ref={sectionRef}>
    <CardSection title="BOARD ALLOCATION">
      {/* ── Warehouse stock search bar ── */}
      {onStockSearch ? (
        <div className="mb-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
            Search warehouse stock
          </div>
          <input
            type="text"
            aria-label="Search warehouse stock"
            placeholder="Code, size, GSM, lot, location, supplier…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-ds-md border border-ds-line/50 bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink outline-none placeholder:text-ds-ink-faint/60 focus:border-ds-line"
          />
          {searchTerm.length >= 2 && (
            <div className="mt-1 rounded-ds-md border border-ds-line/40 bg-ds-elevated overflow-hidden">
              {searching ? (
                <div className="px-3 py-2 text-xs text-ds-ink-faint">Searching…</div>
              ) : searchResults.length === 0 ? (
                <div className="px-3 py-2 text-xs text-ds-ink-faint">No results</div>
              ) : (
                searchResults.map((r) => (
                  <button
                    key={r.materialId}
                    type="button"
                    onClick={() => {
                      selectSearchMaterial(r)
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-ds-line/10 border-b border-ds-line/20 last:border-b-0"
                  >
                    <span className="min-w-0 flex flex-col gap-0.5">
                      <span className="font-semibold text-ds-ink truncate">{r.materialCode}</span>
                      <span className="text-ds-ink-faint truncate">
                        {[r.boardType, r.gsm != null ? `${r.gsm} gsm` : null, r.size].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="shrink-0 flex flex-col items-end gap-0.5 tabular-nums">
                      <span className="text-emerald-300 font-semibold">{nf.format(r.freeSheets)} free</span>
                      {r.storageLocation ? <span className="text-ds-ink-faint">{r.storageLocation}</span> : null}
                      {r.supplierName ? <span className="text-ds-ink-faint truncate max-w-[8rem]">{r.supplierName}</span> : null}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* ── Row 1: Board type | GSM | Sheet size | UPS ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <EditableTile
          label="Total PO qty"
          ariaLabel="Total PO qty"
          type="number"
          value={drafts.poQty}
          placeholder="0"
          onChange={(v) => setDrafts((d) => ({ ...d, poQty: v }))}
          onCommit={commitPoQty}
        />
        <EditableTile
          label="Board type"
          ariaLabel="Board type"
          value={drafts.board}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, board: v }))}
          onCommit={commitBoardType}
        />
        <EditableTile
          label="GSM"
          ariaLabel="GSM"
          type="number"
          value={drafts.gsm}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, gsm: v }))}
          onCommit={commitGsm}
        />
        <EditableTile
          label="Sheet length"
          ariaLabel="Sheet length"
          type="number"
          value={drafts.sheetLength}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, sheetLength: v }))}
          onCommit={commitSheetSpec}
        />
        <EditableTile
          label="Sheet width"
          ariaLabel="Sheet width"
          type="number"
          value={drafts.sheetWidth}
          placeholder="—"
          onChange={(v) => setDrafts((d) => ({ ...d, sheetWidth: v }))}
          onCommit={commitSheetSpec}
        />
        <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
          <label htmlFor="sheet-unit" className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">Sheet unit</label>
          <select id="sheet-unit" aria-label="Sheet unit" value={drafts.sheetUnit}
            onChange={(e) => {
              const v = e.target.value as 'mm' | 'inch'
              setDrafts((d) => ({ ...d, sheetUnit: v }))
              patchSheetSpecFromDrafts({ sheetUnit: v })
            }}
            className="mt-1 w-full bg-ds-elevated border border-ds-line/40 rounded-ds-md px-2 py-1 text-sm font-semibold text-ds-ink outline-none">
            <option value="mm">mm</option>
            <option value="inch">inch</option>
          </select>
        </div>
        <div ref={cutTypeRef} className="relative rounded-ds-md border border-ds-line/40 bg-ds-elevated p-3">
          <div id="cut-type-label" className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">Cut type</div>
          <button
            type="button"
            aria-label="Cut type"
            aria-labelledby="cut-type-label"
            aria-expanded={cutTypeOpen}
            onClick={() => setCutTypeOpen((open) => !open)}
            className="mt-1 flex w-full items-center justify-between rounded-ds-md border border-ds-line/40 bg-ds-elevated px-2 py-1 text-left text-sm font-semibold text-ds-ink outline-none transition focus:border-ds-brand focus:ring-2 focus:ring-ds-brand/20"
          >
            <span>{drafts.cutType ? `${drafts.cutType}-cut` : '—'}</span>
            <ChevronDown className={`h-4 w-4 text-ds-ink-muted transition-transform ${cutTypeOpen ? 'rotate-180' : ''}`} />
          </button>
          {cutTypeOpen ? (
            <div className="absolute left-3 right-3 top-[calc(100%-0.5rem)] z-[260] overflow-hidden rounded-ds-md border border-ds-line/40 bg-white py-1 shadow-[0_14px_34px_rgba(15,23,42,0.18)]">
              <button
                type="button"
                className={`block w-full px-3 py-2 text-left text-sm font-semibold ${drafts.cutType === '' ? 'bg-slate-100 text-ds-ink' : 'text-ds-ink-muted hover:bg-slate-50 hover:text-ds-ink'}`}
                onClick={() => selectCutType('')}
              >
                —
              </button>
              {[1, 2, 3, 4, 5, 6].map((n) => {
                const value = String(n)
                return (
                  <button
                    key={n}
                    type="button"
                    className={`block w-full px-3 py-2 text-left text-sm font-semibold ${drafts.cutType === value ? 'bg-blue-50 text-blue-800' : 'text-ds-ink hover:bg-slate-50'}`}
                    onClick={() => selectCutType(value)}
                  >
                    {n}-cut
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
        <EditableTile
          label="Units per sheet"
          ariaLabel="Units per sheet"
          type="number"
          value={drafts.ups}
          placeholder="—"
          onChange={(v) => {
            setDrafts((d) => ({ ...d, ups: v }))
            onDraftUnitsPerSheetChange?.(v)
          }}
          onCommit={commitUps}
          badge={
            !upsManual && drafts.ups ? (
              <Badge tone="success" className="text-[9px]">
                Auto
              </Badge>
            ) : undefined
          }
        />
      </div>

      {/* ── Row 2: Base sheets (r/o) | Wastage sheets (editable) | Total required (r/o) ── */}
      <div className="grid grid-cols-3 gap-3 mt-3">
        <ReadOnlyTile
          label="Base sheets"
          value={baseSheets != null ? formatSheets(baseSheets) : '—'}
        />
        <EditableTile
          label="Wastage sheets"
          ariaLabel="Wastage sheets"
          type="number"
          value={drafts.wastage}
          placeholder={String(WASTAGE_DEFAULT)}
          onChange={(v) => setDrafts((d) => ({ ...d, wastage: v }))}
          onCommit={commitWastage}
          badge={
            <Badge tone="neutral" className="text-[9px]">
              editable
            </Badge>
          }
        />
        <ReadOnlyTile
          label="Total required"
          value={totalRequired ? formatSheets(totalRequired) : '—'}
        />
      </div>

      {/* ── Warehouse snapshot strip ── */}
      {!readinessLoading && (netStock > 0 || reserved > 0 || incoming > 0) ? (
        <WarehouseStrip
          free={netStock}
          reserved={reserved}
          incoming={incoming}
          required={totalRequired ?? 0}
        />
      ) : null}
    </CardSection>
    </div>
  )
})
