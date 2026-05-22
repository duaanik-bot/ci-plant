'use client'

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import {
  type SheetUnit,
  deriveChildSizeMm,
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
type SheetCutState = { lengthMm: number; widthMm: number; unit: SheetUnit; cutType: number }

function readSheetCut(spec: Record<string, unknown>): SheetCutState {
  const meta = readPlanningMeta(spec)
  const unit = isSheetUnit(meta.sheetUnit) ? meta.sheetUnit : 'in'
  let lengthMm = Number(meta.sheetLengthMm)
  let widthMm = Number(meta.sheetWidthMm)
  // Legacy fallback — derive structured dims from the (mm) parentSize string.
  if (!(lengthMm > 0) || !(widthMm > 0)) {
    const pair = parseSizeNumbers(meta.parentSize)
    if (pair) {
      lengthMm = pair.lengthMm
      widthMm = pair.widthMm
    }
  }
  const cutRaw = Number(meta.cutType ?? meta.cutsPerSheet ?? meta.selectedCutsPerSheet)
  const cutType = Number.isFinite(cutRaw) && cutRaw >= 1 ? Math.floor(cutRaw) : 1
  return {
    lengthMm: lengthMm > 0 ? lengthMm : 0,
    widthMm: widthMm > 0 ? widthMm : 0,
    unit,
    cutType,
  }
}

/**
 * Persist structured sheet/cut spec onto spec.meta. Keeps meta.parentSize (mm)
 * + cut counts in sync so the cut-fit backend and Reserve confirmation keep
 * working unchanged.
 */
function mergeSheetCutMeta(spec: Record<string, unknown>, next: SheetCutState): Record<string, unknown> {
  const meta = { ...readPlanningMeta(spec) }
  const { lengthMm, widthMm, unit, cutType } = next
  meta.sheetUnit = unit
  if (lengthMm > 0 && widthMm > 0) {
    // Store mm at 2-dp precision so an inch round-trip (28in → mm → 28in) is
    // stable; the backend parentSize string still rounds to whole mm.
    meta.sheetLengthMm = Math.round(lengthMm * 100) / 100
    meta.sheetWidthMm = Math.round(widthMm * 100) / 100
    meta.parentSize = formatSizeMm(lengthMm, widthMm)
    const child = deriveChildSizeMm(lengthMm, widthMm, cutType)
    if (child) {
      meta.childSize = formatSizeMm(child.lengthMm, child.widthMm)
      meta.cutSizeUsed = meta.childSize
    } else {
      delete meta.childSize
      delete meta.cutSizeUsed
    }
  } else {
    delete meta.sheetLengthMm
    delete meta.sheetWidthMm
    delete meta.parentSize
    delete meta.childSize
    delete meta.cutSizeUsed
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
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
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
    <div className="bg-ds-elevated/60 rounded-ds-md border border-ds-line/40 p-3">
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

  // Drafts hold display-unit strings; canonical mm is recomputed on commit.
  const [unit, setUnit] = useState<SheetUnit>(current.unit)
  const [length, setLength] = useState('')
  const [width, setWidth] = useState('')
  const [cutType, setCutType] = useState<number>(current.cutType)
  const [customCut, setCustomCut] = useState(false)

  // Resync drafts when the underlying line changes (line switch / external save).
  useEffect(() => {
    setUnit(current.unit)
    setLength(current.lengthMm > 0 ? String(roundForUnit(fromMm(current.lengthMm, current.unit), current.unit)) : '')
    setWidth(current.widthMm > 0 ? String(roundForUnit(fromMm(current.widthMm, current.unit), current.unit)) : '')
    setCutType(current.cutType)
    setCustomCut(!CUT_PRESETS.includes(current.cutType as (typeof CUT_PRESETS)[number]))
  }, [current.lengthMm, current.widthMm, current.unit, current.cutType])

  const draftLengthMm = toMm(Number(length) || 0, unit)
  const draftWidthMm = toMm(Number(width) || 0, unit)
  const child = deriveChildSizeMm(draftLengthMm, draftWidthMm, cutType)

  const commit = useCallback(
    (nextState: Partial<SheetCutState>) => {
      const merged: SheetCutState = {
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

  return (
    <div className="mt-3 rounded-ds-md border border-ds-line/40 bg-ds-elevated/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
          Sheet &amp; cut spec
        </div>
        {/* Unit toggle */}
        <div className="inline-flex overflow-hidden rounded-full border border-ds-line/50 text-[11px]">
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

      {/* Row: length | width | cut type */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <DimInput
          label="Sheet length"
          value={length}
          unit={unit}
          onChange={setLength}
          onCommit={commitDims}
        />
        <DimInput
          label="Sheet width"
          value={width}
          unit={unit}
          onChange={setWidth}
          onCommit={commitDims}
        />
        <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
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

      {/* Row: derived parent | derived child (locked) */}
      <div className="grid grid-cols-2 gap-3 mt-3">
        <DerivedTile
          label="Parent sheet"
          value={draftLengthMm > 0 && draftWidthMm > 0 ? formatSizeDisplay(draftLengthMm, draftWidthMm, unit) : '—'}
        />
        <DerivedTile
          label="Child sheet (after cut)"
          locked
          value={child ? formatSizeDisplay(child.lengthMm, child.widthMm, unit) : '—'}
        />
      </div>
    </div>
  )
})
