'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import { fromMm, roundForUnit, toMm, type SheetUnit } from '@/lib/planning-sheet-cut'
import { parseSheetSizeToPair } from '@/lib/planning-sheet-size'
import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type ChildSizeMm = { lMm: number; wMm: number; qty: number }

type ChildDraft = { id: string; l: string; w: string; qty: string }

type Piece = {
  x: number
  y: number
  w: number
  h: number
  type: 'child' | 'balance'
  childIdx?: number
  sizeMm: { l: number; w: number }
  label: string
}

type CutLayout = {
  parentRect: { x: number; y: number; w: number; h: number }
  pieces: Piece[]
  balanceMm: number
  usedAxisMm: number
}

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  onPatch: SectionPatchFn
}

// ─── Constants ────────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-IN')
const SVG_W = 480
const SVG_H = 300
const SVG_MARGIN = 36

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parses "720 x 1020" / "28 x 40" → {lMm, wMm}. Values > 150 treated as mm;
 *  ≤ 150 treated as inches and converted. Returns null if invalid. */
function parseParentDims(sizeStr: string | null | undefined): { lMm: number; wMm: number } | null {
  if (!sizeStr) return null
  const pair = parseSheetSizeToPair(sizeStr)
  if (!pair) return null
  const { length: a, width: b } = pair
  if (!(a > 0) || !(b > 0)) return null
  const lMm = a > 150 ? a : a * 25.4
  const wMm = b > 150 ? b : b * 25.4
  return { lMm, wMm }
}

function buildCutLayout(
  parentLMm: number,
  parentWMm: number,
  children: ChildSizeMm[],
  direction: 'length' | 'width',
  svgW: number,
  svgH: number,
  margin: number,
  _unit: SheetUnit,
): CutLayout {
  const drawW = svgW - margin * 2
  const drawH = svgH - margin * 2

  // Scale parent to fit viewport
  const scaleX = drawW / parentWMm
  const scaleY = drawH / parentLMm
  const scale = Math.min(scaleX, scaleY)

  const pxW = parentWMm * scale
  const pxH = parentLMm * scale
  const ox = margin + (drawW - pxW) / 2
  const oy = margin + (drawH - pxH) / 2

  const parentRect = { x: ox, y: oy, w: pxW, h: pxH }
  const pieces: Piece[] = []

  if (direction === 'length') {
    // Length-wise: pieces run along the parent length and consume child length
    // across the parent width. Example: 23 x 36 parent with 12 x 23 child
    // places two 12-wide strips and leaves a 12 x 23 balance strip.
    let cursor = 0 // mm along parent width axis
    children.forEach((child, idx) => {
      if (!(child.lMm > 0) || !(child.wMm > 0) || !(child.qty > 0)) return
      for (let q = 0; q < child.qty; q++) {
        if (cursor + child.lMm > parentWMm + 0.01) break
        const px = ox + cursor * scale
        const py = oy
        const pw = child.lMm * scale
        const ph = child.wMm * scale
        pieces.push({
          x: px,
          y: py,
          w: pw,
          h: Math.min(ph, pxH),
          type: 'child',
          childIdx: idx,
          sizeMm: { l: child.lMm, w: child.wMm },
          label: `${Math.round(child.lMm)}×${Math.round(child.wMm)}`,
        })
        cursor += child.lMm
      }
    })
    const usedAxisMm = cursor
    const balanceMm = Math.max(0, parentWMm - usedAxisMm)
    if (balanceMm > 0.5) {
      const px = ox + usedAxisMm * scale
      const pw = balanceMm * scale
      pieces.push({
        x: px,
        y: oy,
        w: pw,
        h: pxH,
        type: 'balance',
        sizeMm: { l: balanceMm, w: parentLMm },
        label: `Balance\n${Math.round(balanceMm)}×${Math.round(parentLMm)}`,
      })
    }
    return { parentRect, pieces, balanceMm, usedAxisMm }
  } else {
    // Width-wise: pieces run along the parent width and consume child width
    // down the parent length.
    let cursor = 0 // mm along parent length axis
    children.forEach((child, idx) => {
      if (!(child.lMm > 0) || !(child.wMm > 0) || !(child.qty > 0)) return
      for (let q = 0; q < child.qty; q++) {
        if (cursor + child.wMm > parentLMm + 0.01) break
        const px = ox
        const py = oy + cursor * scale
        const pw = child.lMm * scale
        const ph = child.wMm * scale
        pieces.push({
          x: px,
          y: py,
          w: Math.min(pw, pxW),
          h: ph,
          type: 'child',
          childIdx: idx,
          sizeMm: { l: child.lMm, w: child.wMm },
          label: `${Math.round(child.lMm)}×${Math.round(child.wMm)}`,
        })
        cursor += child.wMm
      }
    })
    const usedAxisMm = cursor
    const balanceMm = Math.max(0, parentLMm - usedAxisMm)
    if (balanceMm > 0.5) {
      const py = oy + usedAxisMm * scale
      const ph = balanceMm * scale
      pieces.push({
        x: ox,
        y: py,
        w: pxW,
        h: ph,
        type: 'balance',
        sizeMm: { l: parentWMm, w: balanceMm },
        label: `Balance\n${Math.round(parentWMm)}×${Math.round(balanceMm)}`,
      })
    }
    return { parentRect, pieces, balanceMm, usedAxisMm }
  }
}

function fmtDim(mm: number, unit: SheetUnit): string {
  if (!(mm > 0)) return '—'
  const v = roundForUnit(fromMm(mm, unit), unit)
  return `${v} ${unit}`
}

function fmtArea(mm2: number, unit: SheetUnit): string {
  if (!(mm2 > 0)) return '—'
  if (unit === 'in') {
    const in2 = mm2 / (25.4 * 25.4)
    return `${(Math.round(in2 * 100) / 100).toFixed(2)} in²`
  }
  return `${Math.round(mm2)} mm²`
}

function idCounter(): () => string {
  let c = 0
  return () => String(++c)
}

// ─── Sub-components ───────────────────────────────────────────────────────────

type CalcRowProps =
  | { separator: true; label?: never; value?: never; valueClass?: never; large?: never }
  | { separator?: false; label: string; value?: React.ReactNode; valueClass?: string; large?: boolean }

const CalcRow = memo(function CalcRow({
  label,
  value,
  valueClass,
  separator,
  large,
}: CalcRowProps) {
  if (separator) {
    return <div className="my-1 opacity-20 h-px bg-ds-ink-faint" />
  }
  return (
    <div className="grid grid-cols-[minmax(96px,1fr)_minmax(96px,auto)] items-start gap-3 py-0.5">
      <span className="min-w-0 text-xs text-ds-ink-faint">{label}</span>
      <span
        className={`min-w-0 tabular-nums text-right break-words ${large ? 'text-sm font-bold' : 'text-sm font-semibold text-ds-ink'} ${valueClass ?? ''}`}
      >
        {value ?? '—'}
      </span>
    </div>
  )
})

// ─── Main component ───────────────────────────────────────────────────────────

export const SectionCutPlanBalance = memo(function SectionCutPlanBalance({
  line,
  readiness,
  onPatch,
}: Props) {
  // Stable ID counter for child draft rows
  const genId = useRef(idCounter())

  const spec = useMemo(
    () => (line.specOverrides ?? {}) as Record<string, unknown>,
    [line.specOverrides],
  )
  const meta = useMemo(() => readPlanningMeta(spec), [spec])

  // ── Local state ───────────────────────────────────────────────────────────
  const [unit, setUnit] = useState<SheetUnit>('in')
  const [direction, setDirection] = useState<'length' | 'width'>('length')
  const [makeReady, setMakeReady] = useState(0)
  const [makeReadyDraft, setMakeReadyDraft] = useState('0')
  const [childDrafts, setChildDrafts] = useState<ChildDraft[]>(() => [
    { id: genId.current(), l: '', w: '', qty: '1' },
  ])

  // Sync from spec.meta when line.id or relevant meta fields change
  useEffect(() => {
    const dir = meta.cuttingDirection === 'width' ? 'width' : 'length'
    setDirection(dir)

    const mr = typeof meta.makeReadySheets === 'number' ? meta.makeReadySheets : 0
    setMakeReady(mr)
    setMakeReadyDraft(String(mr))

    const raw = meta.cutPlanChildSizes
    if (Array.isArray(raw) && raw.length > 0) {
      const loaded: ChildDraft[] = raw.map((item: unknown) => {
        const o = item as Record<string, unknown>
        const lMm = Number(o.lMm)
        const wMm = Number(o.wMm)
        const qty = Number(o.qty)
        const lDisp = lMm > 0 ? String(roundForUnit(fromMm(lMm, unit), unit)) : ''
        const wDisp = wMm > 0 ? String(roundForUnit(fromMm(wMm, unit), unit)) : ''
        return {
          id: genId.current(),
          l: lDisp,
          w: wDisp,
          qty: qty > 0 ? String(qty) : '1',
        }
      })
      setChildDrafts(loaded)
    } else {
      setChildDrafts([{ id: genId.current(), l: '', w: '', qty: '1' }])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.id])

  // ── Computed values ───────────────────────────────────────────────────────

  const parentDims = useMemo(() => {
    if (readiness?.size) {
      const d = parseParentDims(readiness.size)
      if (d) return d
    }
    const ps = meta.parentSize
    if (typeof ps === 'string') {
      const d = parseParentDims(ps)
      if (d) return d
    }
    const lMm = Number(meta.sheetLengthMm)
    const wMm = Number(meta.sheetWidthMm)
    if (lMm > 0 && wMm > 0) return { lMm, wMm }
    return null
  }, [readiness, meta])

  const childSizesMm = useMemo<ChildSizeMm[]>(() => {
    return childDrafts.map((d) => ({
      lMm: toMm(Number(d.l) || 0, unit),
      wMm: toMm(Number(d.w) || 0, unit),
      qty: Math.max(0, Math.floor(Number(d.qty) || 0)),
    }))
  }, [childDrafts, unit])

  const layout = useMemo<CutLayout | null>(() => {
    if (!parentDims) return null
    return buildCutLayout(
      parentDims.lMm,
      parentDims.wMm,
      childSizesMm,
      direction,
      SVG_W,
      SVG_H,
      SVG_MARGIN,
      unit,
    )
  }, [parentDims, childSizesMm, direction, unit])

  const totalQty = useMemo(() => childSizesMm.reduce((a, c) => a + c.qty, 0), [childSizesMm])

  const validChildren = useMemo(
    () => childSizesMm.filter((c) => c.lMm > 0 && c.wMm > 0 && c.qty > 0),
    [childSizesMm],
  )

  const sizeExceeds = useMemo(() => {
    if (!parentDims || validChildren.length === 0) return false
    if (direction === 'length') {
      const usedWidth = validChildren.reduce((a, c) => a + c.lMm * c.qty, 0)
      const childTooTall = validChildren.some((c) => c.wMm > parentDims.lMm + 0.01)
      return childTooTall || usedWidth > parentDims.wMm + 0.01
    }
    const usedLength = validChildren.reduce((a, c) => a + c.wMm * c.qty, 0)
    const childTooWide = validChildren.some((c) => c.lMm > parentDims.wMm + 0.01)
    return childTooWide || usedLength > parentDims.lMm + 0.01
  }, [validChildren, parentDims, direction])

  const hasCompleteCutPlan = parentDims != null && validChildren.length > 0
  const cutPlanValid = hasCompleteCutPlan && !sizeExceeds

  const usedAreaMm2 = useMemo(
    () => (cutPlanValid ? validChildren.reduce((a, c) => a + c.lMm * c.wMm * c.qty, 0) : 0),
    [cutPlanValid, validChildren],
  )

  const totalAreaMm2 = useMemo(
    () => (parentDims ? parentDims.lMm * parentDims.wMm : 0),
    [parentDims],
  )

  const wastePct = useMemo(() => {
    if (!cutPlanValid || !(totalAreaMm2 > 0) || !(usedAreaMm2 > 0)) return null
    return Math.max(0, (1 - usedAreaMm2 / totalAreaMm2) * 100)
  }, [cutPlanValid, usedAreaMm2, totalAreaMm2])

  const wastageSheets = useMemo(
    () => (typeof meta.wastageSheets === 'number' ? meta.wastageSheets : 150),
    [meta],
  )

  const qty = Number(line.quantity ?? 0)

  const baseSheets = useMemo(() => {
    if (!cutPlanValid || !(totalQty > 0) || !(qty > 0)) return null
    return Math.ceil(qty / totalQty)
  }, [cutPlanValid, totalQty, qty])

  const totalRequired = useMemo(() => {
    if (baseSheets == null) return null
    return baseSheets + makeReady + wastageSheets
  }, [baseSheets, makeReady, wastageSheets])

  const balanceSizeMm = useMemo(() => {
    if (!cutPlanValid || !parentDims || !layout || !(layout.balanceMm > 0.5)) return null
    if (direction === 'length') {
      return { lMm: layout.balanceMm, wMm: parentDims.lMm }
    }
    return { lMm: parentDims.wMm, wMm: layout.balanceMm }
  }, [cutPlanValid, parentDims, layout, direction])

  // ── Commit ────────────────────────────────────────────────────────────────

  const commitState = useCallback(
    (overrides: {
      direction?: 'length' | 'width'
      childSizes?: ChildSizeMm[]
      makeReady?: number
    }) => {
      const nextMeta = { ...readPlanningMeta(spec) }
      const dir = overrides.direction ?? direction
      const sizes = overrides.childSizes ?? childSizesMm
      const mr = overrides.makeReady ?? makeReady
      nextMeta.cuttingDirection = dir
      nextMeta.cutPlanChildSizes = sizes
      const tQty = sizes.reduce((a, c) => a + c.qty, 0)
      nextMeta.cutsPerSheet = tQty
      nextMeta.cutType = tQty
      nextMeta.selectedCutsPerSheet = tQty
      if (sizes.length === 1 && sizes[0].lMm > 0 && sizes[0].wMm > 0) {
        nextMeta.childInputLengthMm = sizes[0].lMm
        nextMeta.childInputWidthMm = sizes[0].wMm
      }
      nextMeta.makeReadySheets = mr
      void onPatch({ specOverrides: { ...spec, meta: nextMeta } })
    },
    [spec, direction, childSizesMm, makeReady, onPatch],
  )

  // ── Unit switching ─────────────────────────────────────────────────────────

  const switchUnit = useCallback(
    (nextUnit: SheetUnit) => {
      if (nextUnit === unit) return
      setChildDrafts((prev) =>
        prev.map((d) => {
          const lMm = toMm(Number(d.l) || 0, unit)
          const wMm = toMm(Number(d.w) || 0, unit)
          return {
            ...d,
            l: lMm > 0 ? String(roundForUnit(fromMm(lMm, nextUnit), nextUnit)) : '',
            w: wMm > 0 ? String(roundForUnit(fromMm(wMm, nextUnit), nextUnit)) : '',
          }
        }),
      )
      setUnit(nextUnit)
    },
    [unit],
  )

  // ── Child draft mutations ─────────────────────────────────────────────────

  const updateChild = useCallback(
    (id: string, field: 'l' | 'w' | 'qty', value: string) => {
      setChildDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, [field]: value } : d)))
    },
    [],
  )

  const removeChild = useCallback((id: string) => {
    setChildDrafts((prev) => {
      if (prev.length <= 1) return prev
      return prev.filter((d) => d.id !== id)
    })
  }, [])

  const addChild = useCallback(() => {
    setChildDrafts((prev) => [
      ...prev,
      { id: genId.current(), l: '', w: '', qty: '1' },
    ])
  }, [])

  const commitChildren = useCallback(() => {
    const sizes: ChildSizeMm[] = childDrafts.map((d) => ({
      lMm: toMm(Number(d.l) || 0, unit),
      wMm: toMm(Number(d.w) || 0, unit),
      qty: Math.max(0, Math.floor(Number(d.qty) || 0)),
    }))
    commitState({ childSizes: sizes })
  }, [childDrafts, unit, commitState])

  const commitMakeReady = useCallback(() => {
    const mr = Math.max(0, Math.floor(Number(makeReadyDraft) || 0))
    setMakeReady(mr)
    commitState({ makeReady: mr })
  }, [makeReadyDraft, commitState])

  // ── Render ────────────────────────────────────────────────────────────────

  const parentLDisplay = parentDims ? fmtDim(parentDims.lMm, unit) : '—'
  const parentWDisplay = parentDims ? fmtDim(parentDims.wMm, unit) : '—'

  const wastePctClass =
    wastePct == null
      ? 'text-ds-ink'
      : wastePct < 10
        ? 'text-emerald-300'
        : wastePct < 25
          ? 'text-amber-300'
          : 'text-red-400'

  // Unique child colors for SVG
  const CHILD_COLORS = [
    { fill: 'rgba(16,185,129,0.25)', stroke: 'rgba(16,185,129,0.6)' },
    { fill: 'rgba(99,102,241,0.25)', stroke: 'rgba(99,102,241,0.6)' },
    { fill: 'rgba(236,72,153,0.2)', stroke: 'rgba(236,72,153,0.5)' },
    { fill: 'rgba(251,191,36,0.2)', stroke: 'rgba(251,191,36,0.5)' },
  ]

  return (
    <CardSection title="CUT PLAN & LAYOUT">
      <div className="grid grid-cols-1 2xl:grid-cols-[320px_minmax(380px,1fr)_310px] gap-4">
        {/* ── Left: Cutting Configuration ─────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              Cutting Configuration
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

          {/* Direction toggle */}
          <div className="bg-ds-elevated rounded-ds-md p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-2">
              Cutting Direction
            </div>
            <div className="inline-flex gap-1.5">
              {(['length', 'width'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    setDirection(d)
                    commitState({ direction: d })
                  }}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                    direction === d
                      ? 'bg-ds-brand/20 text-ds-brand ring-1 ring-[var(--brand-primary)]/25'
                      : 'text-ds-ink-muted hover:text-ds-ink bg-ds-main'
                  }`}
                >
                  {d === 'length' ? 'Length-wise' : 'Width-wise'}
                </button>
              ))}
            </div>
          </div>

          {/* Child size rows */}
          {childDrafts.map((draft, idx) => (
            <div
              key={draft.id}
              className="bg-ds-elevated rounded-ds-md p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                  Child Size {idx + 1} (L × W)
                </div>
                {childDrafts.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => {
                      removeChild(draft.id)
                      // Commit after removal via effect would race; trigger on next tick
                      setTimeout(() => commitChildren(), 0)
                    }}
                    className="text-ds-ink-faint hover:text-red-400 text-[11px] leading-none transition-colors"
                    aria-label={`Remove child size ${idx + 1}`}
                  >
                    ×
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] text-ds-ink-faint mb-0.5">Length ({unit})</div>
                  <div className="flex items-baseline gap-1">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={draft.l}
                      placeholder="—"
                      onChange={(e) => updateChild(draft.id, 'l', e.target.value)}
                      onBlur={commitChildren}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      }}
                      aria-label={`Child ${idx + 1} length`}
                      className="w-full bg-transparent text-sm font-semibold text-ds-ink outline-none tabular-nums placeholder:text-ds-ink-faint/60"
                    />
                    <span className="text-[10px] text-ds-ink-faint shrink-0">{unit}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-ds-ink-faint mb-0.5">Width ({unit})</div>
                  <div className="flex items-baseline gap-1">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={draft.w}
                      placeholder="—"
                      onChange={(e) => updateChild(draft.id, 'w', e.target.value)}
                      onBlur={commitChildren}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      }}
                      aria-label={`Child ${idx + 1} width`}
                      className="w-full bg-transparent text-sm font-semibold text-ds-ink outline-none tabular-nums placeholder:text-ds-ink-faint/60"
                    />
                    <span className="text-[10px] text-ds-ink-faint shrink-0">{unit}</span>
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[10px] text-ds-ink-faint mb-0.5">Qty per Sheet</div>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={draft.qty}
                  placeholder="1"
                  onChange={(e) => updateChild(draft.id, 'qty', e.target.value)}
                  onBlur={commitChildren}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  aria-label={`Child ${idx + 1} qty per sheet`}
                  className="w-24 bg-transparent text-sm font-semibold text-ds-ink outline-none tabular-nums placeholder:text-ds-ink-faint/60"
                />
              </div>
            </div>
          ))}

          {/* Add child */}
          <button
            type="button"
            onClick={addChild}
            className="text-xs font-semibold text-ds-brand hover:opacity-80 transition-opacity"
          >
            + Add another child size
          </button>

          {/* Make-ready sheets */}
          <div className="bg-ds-elevated rounded-ds-md p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-1">
              Make-ready Sheets
            </div>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={makeReadyDraft}
              placeholder="0"
              onChange={(e) => setMakeReadyDraft(e.target.value)}
              onBlur={commitMakeReady}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              aria-label="Make-ready sheets"
              className="w-full bg-transparent text-base font-semibold text-ds-ink outline-none tabular-nums placeholder:text-ds-ink-faint/60"
            />
          </div>

          {/* Overflow warning */}
          {sizeExceeds ? (
            <div className="rounded-ds-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
              Cut sizes exceed parent sheet dimensions
            </div>
          ) : null}
        </div>

        {/* ── Center: Visual Layout ────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              Visual Layout (Top View)
            </div>
            <Badge tone={direction === 'length' ? 'brand' : 'neutral'} className="text-[9px]">
              {direction === 'length' ? 'Length-wise' : 'Width-wise'}
            </Badge>
          </div>

          <div className="relative min-h-[320px] bg-ds-elevated/60 rounded-ds-md overflow-hidden">
            {!parentDims ? (
              <div className="flex items-center justify-center h-[300px] px-6 text-center">
                <p className="text-xs text-ds-ink-faint leading-relaxed">
                  Select a board from warehouse to visualise the cut layout
                </p>
              </div>
            ) : (
              <svg
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="w-full h-full"
                aria-label="Cut layout diagram"
              >
                {layout && (
                  <>
                    {/* Parent sheet rect */}
                    <rect
                      x={layout.parentRect.x}
                      y={layout.parentRect.y}
                      width={layout.parentRect.w}
                      height={layout.parentRect.h}
                      fill="rgba(255,255,255,0.04)"
                      stroke="rgba(255,255,255,0.2)"
                      strokeWidth={1}
                      rx={2}
                    />

                    {/* Pieces */}
                    {layout.pieces.map((piece, i) => {
                      const isBalance = piece.type === 'balance'
                      const color = isBalance
                        ? { fill: 'rgba(245,158,11,0.2)', stroke: 'rgba(245,158,11,0.5)' }
                        : (CHILD_COLORS[(piece.childIdx ?? 0) % CHILD_COLORS.length])!
                      const cx = piece.x + piece.w / 2
                      const cy = piece.y + piece.h / 2
                      const labelParts = piece.label.split('\n')
                      return (
                        <g key={i}>
                          <rect
                            x={piece.x + 0.5}
                            y={piece.y + 0.5}
                            width={Math.max(0, piece.w - 1)}
                            height={Math.max(0, piece.h - 1)}
                            fill={color.fill}
                            stroke={color.stroke}
                            strokeWidth={1}
                            strokeDasharray={isBalance ? '4,2' : undefined}
                            rx={1}
                          />
                          {piece.w > 32 && piece.h > 16 ? (
                            <>
                              {labelParts.map((part, li) => (
                                <text
                                  key={li}
                                  x={cx}
                                  y={cy + (li - (labelParts.length - 1) / 2) * 12}
                                  textAnchor="middle"
                                  dominantBaseline="middle"
                                  fontSize="9"
                                  className={isBalance ? 'fill-amber-300' : 'fill-emerald-200'}
                                >
                                  {part}
                                </text>
                              ))}
                            </>
                          ) : null}
                          {/* Cut lines between pieces (dashed separator) */}
                          {!isBalance && i > 0 && layout.pieces[i - 1]?.type === 'child' ? (
                            direction === 'length' ? (
                              <line
                                x1={piece.x}
                                y1={layout.parentRect.y}
                                x2={piece.x}
                                y2={layout.parentRect.y + layout.parentRect.h}
                                stroke="rgba(255,255,255,0.15)"
                                strokeWidth={1}
                                strokeDasharray="3,3"
                              />
                            ) : (
                              <line
                                x1={layout.parentRect.x}
                                y1={piece.y}
                                x2={layout.parentRect.x + layout.parentRect.w}
                                y2={piece.y}
                                stroke="rgba(255,255,255,0.15)"
                                strokeWidth={1}
                                strokeDasharray="3,3"
                              />
                            )
                          ) : null}
                        </g>
                      )
                    })}

                    {/* Parent L label — left edge */}
                    <text
                      x={layout.parentRect.x - 4}
                      y={layout.parentRect.y + layout.parentRect.h / 2}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize="9"
                      className="fill-ds-ink-faint"
                      transform={`rotate(-90,${layout.parentRect.x - 14},${layout.parentRect.y + layout.parentRect.h / 2})`}
                    >
                      L {parentLDisplay}
                    </text>

                    {/* Parent W label — top edge */}
                    <text
                      x={layout.parentRect.x + layout.parentRect.w / 2}
                      y={layout.parentRect.y - 8}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize="9"
                      className="fill-ds-ink-faint"
                    >
                      W {parentWDisplay}
                    </text>
                  </>
                )}
              </svg>
            )}
            {sizeExceeds ? (
              <div className="absolute inset-x-3 bottom-3 rounded-ds-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 shadow-ds-depth">
                Invalid cut plan. Reduce child quantity or dimensions before using this layout.
              </div>
            ) : null}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-3 text-[11px]">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm border"
                style={{ background: 'rgba(16,185,129,0.3)', borderColor: 'rgba(16,185,129,0.6)' }}
              />
              <span className="text-ds-ink-faint">
                Used{totalQty > 0 ? ` (${totalQty} pcs)` : ''}
              </span>
            </span>
            {balanceSizeMm ? (
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm border"
                  style={{ background: 'rgba(245,158,11,0.2)', borderColor: 'rgba(245,158,11,0.5)', borderStyle: 'dashed' }}
                />
                <span className="text-ds-ink-faint">Usable Balance</span>
              </span>
            ) : null}
            {wastePct != null && wastePct > 0.5 ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-500/30" />
                <span className="text-ds-ink-faint">Waste</span>
              </span>
            ) : null}
          </div>
        </div>

        {/* ── Right: Calculation Summary ───────────────────────────────────── */}
        <div className="space-y-0.5 rounded-ds-md border border-ds-line/20 bg-ds-elevated/35 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint mb-2">
            Calculation Summary
          </div>

          <CalcRow
            label="Parent Sheet Size"
            value={
              parentDims
                ? `${fmtDim(parentDims.lMm, unit)} × ${fmtDim(parentDims.wMm, unit)}`
                : '—'
            }
          />
          <CalcRow label="Total Area" value={fmtArea(totalAreaMm2, unit)} />
          <CalcRow
            label="Used Area"
            value={
              cutPlanValid && usedAreaMm2 > 0 && totalAreaMm2 > 0 ? (
                <span className="flex items-center gap-1.5 justify-end">
                  <span>{fmtArea(usedAreaMm2, unit)}</span>
                  <span className="text-emerald-300 text-xs">
                    ({Math.round((usedAreaMm2 / totalAreaMm2) * 100)}%)
                  </span>
                </span>
              ) : sizeExceeds ? (
                <span className="text-red-300">Invalid</span>
              ) : (
                '—'
              )
            }
          />
          <CalcRow
            label="Balance Area"
            value={
              cutPlanValid && totalAreaMm2 > 0 && usedAreaMm2 > 0 ? (
                <span className="text-amber-300">
                  {fmtArea(Math.max(0, totalAreaMm2 - usedAreaMm2), unit)}
                </span>
              ) : sizeExceeds ? (
                <span className="text-red-300">Invalid</span>
              ) : (
                '—'
              )
            }
          />
          <CalcRow
            label="Waste %"
            value={wastePct != null ? `${wastePct.toFixed(1)}%` : '—'}
            valueClass={wastePctClass}
          />

          <CalcRow separator />

          <CalcRow
            label="Yield (pcs / sheet)"
            value={cutPlanValid && totalQty > 0 ? <span className="font-bold">{nf.format(totalQty)}</span> : sizeExceeds ? <span className="text-red-300">Invalid</span> : '—'}
          />
          <CalcRow
            label="Sheets Reqd (Base)"
            value={baseSheets != null ? `${nf.format(baseSheets)} sh` : '—'}
          />
          <CalcRow
            label="Make-ready Sheets"
            value={`${nf.format(makeReady)} sh`}
          />
          <CalcRow
            label="Wastage Sheets"
            value={`${nf.format(wastageSheets)} sh`}
          />

          <CalcRow separator />

          <CalcRow
            label="Total Required"
            large
            value={
              totalRequired != null ? (
                <span className="text-ds-brand">{nf.format(totalRequired)} sh</span>
              ) : (
                '—'
              )
            }
          />

          {/* Balance stock KPI */}
          {balanceSizeMm && baseSheets != null ? (
            <div className="mt-3 rounded-ds-md bg-amber-500/10 px-3 py-2.5 space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/80 mb-1">
                Balance Stock
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-ds-ink-faint">Balance Size</span>
                <span className="font-semibold text-ds-ink tabular-nums">
                  {fmtDim(balanceSizeMm.lMm, unit)} × {fmtDim(balanceSizeMm.wMm, unit)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-ds-ink-faint">Qty / Board</span>
                <span className="font-semibold text-ds-ink">1 pc</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-ds-ink-faint">Total Balance</span>
                <span className="font-semibold text-ds-ink tabular-nums">
                  {nf.format(baseSheets)} sh
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </CardSection>
  )
})
