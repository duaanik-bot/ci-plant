'use client'

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningMeta, mergePlanningMetaUps } from '@/lib/planning-decision-spec'
import { mergeSpecPackUps } from '@/lib/carton-spec-pack'
import { resolveUps } from '@/lib/production-os-resolvers'
import {
  type SheetUnit,
  deriveChildSizeMm,
  deriveParentSizeMm,
  formatSizeDisplay,
  formatSizeMm,
  fromMm,
  isSheetUnit,
  roundForUnit,
  toMm,
} from '@/lib/planning-sheet-cut'
import type { PlanningEngineLine, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  onPatch: SectionPatchFn
}

const CUT_PRESETS = [1, 2, 3, 4, 5, 6, 7, 8] as const
const nf = new Intl.NumberFormat('en-IN')

/** Extract the first two positive numbers from a size string, tolerating unit
 * suffixes and separators (e.g. "720×1020 mm", "720 x 1020"). */
function parseSizeNumbers(raw: unknown): { lengthMm: number; widthMm: number } | null {
  if (typeof raw !== 'string') return null
  const nums = raw.match(/\d+(?:\.\d+)?/g)
  if (!nums || nums.length < 2) return null
  const a = Number(nums[0])
  const b = Number(nums[1])
  if (!(a > 0) || !(b > 0)) return null
  return { lengthMm: a, widthMm: b }
}

// ─── Read current structured sheet/cut values from spec.meta ──────────────────
// NOTE: In the new design lengthMm/widthMm represent the CHILD (cut) sheet size,
// not the parent board sheet. The parent is always derived from child × cutType.
type SheetCutState = { lengthMm: number; widthMm: number; unit: SheetUnit; cutType: number }

function readSheetCut(spec: Record<string, unknown>): SheetCutState {
  const meta = readPlanningMeta(spec)
  const unit = isSheetUnit(meta.sheetUnit) ? meta.sheetUnit : 'in'

  const cutRaw = Number(meta.cutType ?? meta.cutsPerSheet ?? meta.selectedCutsPerSheet)
  const cutType = Number.isFinite(cutRaw) && cutRaw >= 1 ? Math.floor(cutRaw) : 1

  // New storage: child input dims under childInputLengthMm / childInputWidthMm.
  let childLengthMm = Number(meta.childInputLengthMm)
  let childWidthMm = Number(meta.childInputWidthMm)

  // Legacy fallback — if child input not stored, derive from old parent dims.
  if (!(childLengthMm > 0) || !(childWidthMm > 0)) {
    const parentL = Number(meta.sheetLengthMm)
    const parentW = Number(meta.sheetWidthMm)
    if (parentL > 0 && parentW > 0) {
      const child = deriveChildSizeMm(parentL, parentW, cutType)
      if (child) {
        childLengthMm = child.lengthMm
        childWidthMm = child.widthMm
      }
    }
  }
  // Legacy fallback — derive child from parentSize string.
  if (!(childLengthMm > 0) || !(childWidthMm > 0)) {
    const pair = parseSizeNumbers(meta.parentSize)
    if (pair) {
      const child = deriveChildSizeMm(pair.lengthMm, pair.widthMm, cutType)
      if (child) {
        childLengthMm = child.lengthMm
        childWidthMm = child.widthMm
      }
    }
  }

  return {
    lengthMm: childLengthMm > 0 ? childLengthMm : 0,
    widthMm: childWidthMm > 0 ? childWidthMm : 0,
    unit,
    cutType,
  }
}

/**
 * Persist structured sheet/cut spec onto spec.meta.
 *
 * New design: lengthMm/widthMm are the CHILD (cut) sheet dims entered by the
 * planner. The parent board sheet is derived as child.longer × cutType and
 * stored as meta.parentSize / meta.sheetLengthMm / meta.sheetWidthMm so all
 * downstream consumers (cut-fit, Reserve confirmation, smart match) continue
 * to work unchanged.
 */
function mergeSheetCutMeta(spec: Record<string, unknown>, next: SheetCutState): Record<string, unknown> {
  const meta = { ...readPlanningMeta(spec) }
  const { lengthMm: childL, widthMm: childW, unit, cutType } = next
  meta.sheetUnit = unit

  if (childL > 0 && childW > 0) {
    // Store child input dims (new keys so we can distinguish from old parent dims).
    meta.childInputLengthMm = Math.round(childL * 100) / 100
    meta.childInputWidthMm = Math.round(childW * 100) / 100
    meta.childSize = formatSizeMm(childL, childW)
    meta.cutSizeUsed = meta.childSize

    // Derive parent board sheet and store for all downstream consumers.
    const parent = deriveParentSizeMm(childL, childW, cutType)
    if (parent) {
      meta.sheetLengthMm = Math.round(parent.lengthMm * 100) / 100
      meta.sheetWidthMm = Math.round(parent.widthMm * 100) / 100
      meta.parentSize = formatSizeMm(parent.lengthMm, parent.widthMm)
    } else {
      delete meta.sheetLengthMm
      delete meta.sheetWidthMm
      delete meta.parentSize
    }
  } else {
    delete meta.childInputLengthMm
    delete meta.childInputWidthMm
    delete meta.childSize
    delete meta.cutSizeUsed
    delete meta.sheetLengthMm
    delete meta.sheetWidthMm
    delete meta.parentSize
  }

  meta.cutType = cutType
  meta.cutsPerSheet = cutType
  meta.selectedCutsPerSheet = cutType
  const nextSpec = { ...spec }
  nextSpec.meta = meta
  return nextSpec
}

// ─── Tiles ────────────────────────────────────────────────────────────────────
const DimInput = memo(function DimInput({
  label,
  value,
  unit,
  onChange,
  onCommit,
}: {
  label: string
  value: string
  unit: SheetUnit
  onChange: (v: string) => void
  onCommit: () => void
}) {
  return (
    <div className="bg-ds-elevated rounded-ds-md p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={value}
          placeholder="—"
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          aria-label={`${label} (${unit})`}
          className="w-full bg-transparent text-base font-semibold text-ds-ink outline-none leading-tight tabular-nums placeholder:text-ds-ink-faint/60"
        />
        <span className="text-[11px] text-ds-ink-faint shrink-0">{unit}</span>
      </div>
    </div>
  )
})

const DerivedTile = memo(function DerivedTile({
  label,
  value,
  locked,
}: {
  label: string
  value: string
  locked?: boolean
}) {
  return (
    <div className="bg-ds-elevated/60 rounded-ds-md p-3">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
        {locked ? (
          <Badge tone="neutral" className="text-[9px]">
            auto
          </Badge>
        ) : null}
      </div>
      <div className="text-base font-semibold text-ds-ink leading-tight tabular-nums">{value}</div>
    </div>
  )
})

// ─── Main ───────────────────────────────────────────────────────────────────
export const SheetCutSpec = memo(function SheetCutSpec({ line, onPatch }: Props) {
  const spec = useMemo(() => (line.specOverrides ?? {}) as Record<string, unknown>, [line.specOverrides])
  const current = useMemo(() => readSheetCut(spec), [spec])

  // UPS — resolved from spec/meta/carton, same logic as SectionBoardAllocation.
  const resolvedUps = useMemo(() => (resolveUps(line) ?? null) as number | null, [line])

  // Drafts hold display-unit strings; canonical mm is recomputed on commit.
  const [unit, setUnit] = useState<SheetUnit>(current.unit)
  const [length, setLength] = useState('')
  const [width, setWidth] = useState('')
  const [cutType, setCutType] = useState<number>(current.cutType)
  const [customCut, setCustomCut] = useState(false)
  const [upsDraft, setUpsDraft] = useState(resolvedUps != null ? String(resolvedUps) : '')

  // Resync drafts when the underlying line changes (line switch / external save).
  useEffect(() => {
    setUnit(current.unit)
    setLength(current.lengthMm > 0 ? String(roundForUnit(fromMm(current.lengthMm, current.unit), current.unit)) : '')
    setWidth(current.widthMm > 0 ? String(roundForUnit(fromMm(current.widthMm, current.unit), current.unit)) : '')
    setCutType(current.cutType)
    setCustomCut(!CUT_PRESETS.includes(current.cutType as (typeof CUT_PRESETS)[number]))
  }, [current.lengthMm, current.widthMm, current.unit, current.cutType])

  useEffect(() => {
    setUpsDraft(resolvedUps != null ? String(resolvedUps) : '')
  }, [resolvedUps])

  // Child dims are what the planner enters; parent is auto-derived.
  const draftChildLengthMm = toMm(Number(length) || 0, unit)
  const draftChildWidthMm = toMm(Number(width) || 0, unit)
  const derivedParent = deriveParentSizeMm(draftChildLengthMm, draftChildWidthMm, cutType)

  // Sheet yield calculations.
  const qty = Number(line.quantity ?? 0)
  const upsVal = Number(upsDraft) || null
  const baseSheets = upsVal && upsVal > 0 && qty > 0 ? Math.ceil(qty / upsVal) : null
  // Units yield = how many carton units can actually be produced from baseSheets × UPS
  // (= first multiple of UPS that covers qty, i.e. the actual planned production batch)
  const unitsYield = baseSheets != null && upsVal ? baseSheets * upsVal : null

  const commit = useCallback(
    (nextState: Partial<SheetCutState>) => {
      const merged: SheetCutState = {
        // lengthMm / widthMm are child dims
        lengthMm: nextState.lengthMm ?? toMm(Number(length) || 0, unit),
        widthMm: nextState.widthMm ?? toMm(Number(width) || 0, unit),
        unit: nextState.unit ?? unit,
        cutType: nextState.cutType ?? cutType,
      }
      void onPatch({ specOverrides: mergeSheetCutMeta(spec, merged) })
    },
    [length, width, unit, cutType, spec, onPatch],
  )

  const commitDims = useCallback(() => commit({}), [commit])

  const commitUps = useCallback(() => {
    const next = upsDraft.trim() === '' ? null : Math.max(1, Math.floor(Number(upsDraft) || 0))
    // Resolve current spec-pack UPS to avoid redundant writes.
    const sp = spec.specPack as Record<string, unknown> | undefined
    const sheetPack = sp && typeof sp === 'object' ? (sp.sheet as Record<string, unknown> | undefined) : undefined
    const specPackUps = sheetPack ? Number(sheetPack.ups) : Number.NaN
    const currentSpecPackUps = Number.isFinite(specPackUps) ? Math.floor(specPackUps) : null
    if (next === resolvedUps && next === currentSpecPackUps) return
    const withMeta = mergePlanningMetaUps(spec, next)
    void onPatch({ specOverrides: mergeSpecPackUps(withMeta, next) })
  }, [upsDraft, resolvedUps, spec, onPatch])

  const switchUnit = useCallback(
    (nextUnit: SheetUnit) => {
      if (nextUnit === unit) return
      // Convert visible drafts so the physical size is preserved.
      const lMm = toMm(Number(length) || 0, unit)
      const wMm = toMm(Number(width) || 0, unit)
      setUnit(nextUnit)
      setLength(lMm > 0 ? String(roundForUnit(fromMm(lMm, nextUnit), nextUnit)) : '')
      setWidth(wMm > 0 ? String(roundForUnit(fromMm(wMm, nextUnit), nextUnit)) : '')
      commit({ unit: nextUnit, lengthMm: lMm, widthMm: wMm })
    },
    [unit, length, width, commit],
  )

  const changeCut = useCallback(
    (next: number) => {
      const n = Math.max(1, Math.floor(next || 1))
      setCutType(n)
      commit({ cutType: n })
    },
    [commit],
  )

  // Read meta.ups to decide whether to show the Auto badge.
  const meta = useMemo(() => readPlanningMeta(spec), [spec])
  const upsIsAuto = meta?.upsSource !== 'manual' && !!upsDraft

  return (
    <div className="mt-3 rounded-ds-md bg-ds-elevated/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
          Sheet &amp; cut spec
        </div>
        {/* Unit toggle */}
        <div className="inline-flex overflow-hidden rounded-full bg-ds-elevated text-[11px]">
          {(['in', 'mm'] as const).map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => switchUnit(u)}
              aria-pressed={unit === u}
              className={`px-2.5 py-0.5 font-medium transition-colors ${
                unit === u ? 'bg-ds-brand/15 text-ds-brand' : 'text-ds-ink-faint hover:text-ds-ink'
              }`}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      {/* Row 1: cut length | cut width | cut type */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <DimInput
          label="Cut length"
          value={length}
          unit={unit}
          onChange={setLength}
          onCommit={commitDims}
        />
        <DimInput
          label="Cut width"
          value={width}
          unit={unit}
          onChange={setWidth}
          onCommit={commitDims}
        />
        <div className="bg-ds-elevated rounded-ds-md p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
            Cut type
          </div>
          {customCut ? (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={cutType}
                onChange={(e) => setCutType(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                onBlur={() => changeCut(cutType)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                aria-label="Custom cut count"
                className="w-full bg-transparent text-base font-semibold text-ds-ink outline-none leading-tight tabular-nums"
              />
              <button
                type="button"
                onClick={() => {
                  setCustomCut(false)
                  changeCut(1)
                }}
                className="text-[11px] text-ds-ink-faint hover:text-ds-ink shrink-0"
              >
                presets
              </button>
            </div>
          ) : (
            <select
              value={cutType}
              onChange={(e) => {
                if (e.target.value === 'custom') {
                  setCustomCut(true)
                  return
                }
                changeCut(Number(e.target.value))
              }}
              aria-label="Cut type"
              className="w-full bg-transparent text-base font-semibold text-ds-ink outline-none leading-tight tabular-nums"
            >
              {CUT_PRESETS.map((c) => (
                <option key={c} value={c}>
                  {c}-cut
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          )}
        </div>
      </div>

      {/* Row 2: board sheet (auto) | UPS (editable) */}
      <div className="grid grid-cols-2 gap-3 mt-3">
        <DerivedTile
          label="Board sheet"
          locked
          value={derivedParent ? formatSizeDisplay(derivedParent.lengthMm, derivedParent.widthMm, unit) : '—'}
        />
        {/* UPS — editable, writes to meta.ups + specPack.sheet.ups */}
        <div className="bg-ds-elevated rounded-ds-md p-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              Units per sheet
            </div>
            {upsIsAuto ? (
              <Badge tone="success" className="text-[9px]">
                Auto
              </Badge>
            ) : null}
          </div>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={upsDraft}
            placeholder="—"
            onChange={(e) => setUpsDraft(e.target.value)}
            onBlur={commitUps}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            aria-label="Units per sheet"
            className="w-full bg-transparent text-base font-semibold text-ds-ink outline-none leading-tight tabular-nums placeholder:text-ds-ink-faint/60"
          />
        </div>
      </div>

      {/* Row 3: base sheets (auto) | units yield (auto) */}
      {(baseSheets != null || unitsYield != null) ? (
        <div className="grid grid-cols-2 gap-3 mt-3">
          <DerivedTile
            label="Base sheets"
            locked
            value={baseSheets != null ? `${nf.format(baseSheets)} sh` : '—'}
          />
          <DerivedTile
            label="Units yield"
            locked
            value={unitsYield != null ? nf.format(unitsYield) : '—'}
          />
        </div>
      ) : null}
    </div>
  )
})
