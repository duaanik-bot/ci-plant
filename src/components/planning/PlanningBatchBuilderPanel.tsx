'use client'

import { useMemo } from 'react'
import { AlertTriangle, Layers, Plus, X } from 'lucide-react'
import {
  boardLabel,
  type PlanningGridLine,
  type PlanningLineFieldPatch,
} from '@/components/planning/PlanningDecisionGrid'
import { mergePlanningMetaUps, readPlanningCore, readPlanningMeta } from '@/lib/planning-decision-spec'
import { BATCH_STATUS_BADGE_CLASS, BATCH_STATUS_LABEL, effectiveBatchStatus } from '@/lib/planning-batch-decision'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type CompRow = {
  key: string
  /** Full line e.g. "Board: Match (SBS)" */
  text: string
  mixed: boolean
}

function aggregateDisplay(values: string[]): { match: boolean; detail: string } {
  const seen = new Map<string, string>()
  for (const raw of values) {
    const display = raw.trim() || '—'
    const k = display.toLowerCase()
    if (!seen.has(k)) seen.set(k, display)
  }
  const arr = Array.from(seen.values())
  return { match: arr.length <= 1, detail: arr.join(' · ') }
}

function printingLabel(r: PlanningGridLine): string {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const raw = spec.printingProcess ?? spec.printType ?? spec.printingType
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  const nc = r.planningLedger?.numberOfColours ?? r.carton?.numberOfColours
  if (typeof nc === 'number' && nc > 0) return `${nc}-colour`
  return '—'
}

function coatingLine(r: PlanningGridLine): string {
  const parts = [r.coatingType, r.otherCoating].map((s) => s?.trim()).filter(Boolean) as string[]
  if (parts.length) return parts.join(' + ')
  const c = r.carton?.coatingType?.trim()
  return c || '—'
}

function specialLine(r: PlanningGridLine): string {
  const parts: string[] = []
  const e = r.embossingLeafing?.trim()
  if (e) parts.push(e)
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const foil = typeof spec.foilType === 'string' ? spec.foilType.trim() : ''
  if (foil) parts.push(`Foil ${foil}`)
  return parts.length ? parts.join(', ') : 'None'
}

function plateBucket(r: PlanningGridLine): 'existing' | 'partial' | 'new' | 'unknown' {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const ps = spec.platesStatus
  if (ps === 'available') return 'existing'
  if (ps === 'partial') return 'partial'
  if (ps === 'new_required') return 'new'
  return 'unknown'
}

function plateAggregate(lines: PlanningGridLine[]): { match: boolean; detail: string } {
  const counts = { existing: 0, partial: 0, new: 0, unknown: 0 }
  for (const r of lines) {
    counts[plateBucket(r)] += 1
  }
  const parts: string[] = []
  if (counts.existing) parts.push(`${counts.existing} existing`)
  if (counts.partial) parts.push(`${counts.partial} partial`)
  if (counts.new) parts.push(`${counts.new} new`)
  if (counts.unknown) parts.push(`${counts.unknown} unspecified`)
  const active = (['existing', 'partial', 'new', 'unknown'] as const).filter((k) => counts[k] > 0)
  const match = active.length <= 1
  if (match) {
    if (active.length === 0) return { match: true, detail: 'Unspecified' }
    const k = active[0]
    const label = k === 'existing' ? 'Existing' : k === 'partial' ? 'Partial' : k === 'new' ? 'New' : 'Unspecified'
    const n = counts[k]
    return { match: true, detail: `${label} (${n} job${n === 1 ? '' : 's'})` }
  }
  return { match: false, detail: parts.join(' / ') }
}

function dieAggregate(lines: PlanningGridLine[]): { match: boolean; detail: string } {
  const sigs = lines.map((r) => (r.dieMaster ? `Dye ${r.dieMaster.dyeNumber}` : 'None'))
  return aggregateDisplay(sigs)
}

function gsmLine(r: PlanningGridLine): string {
  const g = r.gsm ?? r.carton?.gsm
  if (g == null || Number.isNaN(Number(g))) return '—'
  return String(g)
}

function buildCompatibilityRows(lines: PlanningGridLine[]): CompRow[] {
  if (lines.length < 2) return []

  const boardVals = lines.map((r) => boardLabel(r))
  const board = aggregateDisplay(boardVals)
  const sizeVals = lines.map((r) => String(r.cartonSize ?? '').trim() || '—')
  const size = aggregateDisplay(sizeVals)
  const printVals = lines.map((r) => printingLabel(r))
  const print = aggregateDisplay(printVals)
  const coatVals = lines.map((r) => coatingLine(r))
  const coat = aggregateDisplay(coatVals)
  const specVals = lines.map((r) => specialLine(r))
  const spec = aggregateDisplay(specVals)
  const gsmVals = lines.map((r) => gsmLine(r))
  const gsm = aggregateDisplay(gsmVals)
  const plate = plateAggregate(lines)
  const die = dieAggregate(lines)

  const row = (key: string, label: string, match: boolean, detail: string): CompRow => ({
    key,
    mixed: !match,
    text: `${label}: ${match ? 'Match' : 'Mixed'} (${detail})`,
  })

  return [
    row('board', 'Board', board.match, board.detail),
    row('size', 'Size', size.match, size.detail),
    row('printing', 'Printing', print.match, print.detail),
    row('coating', 'Coating / finish', coat.match, coat.detail),
    row('special', 'Special processes', spec.match, spec.detail),
    row('tool-plate', 'Plate (planning)', plate.match, plate.detail),
    row('tool-die', 'Die', die.match, die.detail),
    row('gsm', 'GSM', gsm.match, gsm.detail),
  ]
}

type Props = {
  isOpen: boolean
  lines: PlanningGridLine[]
  onCreateBatch: () => void
  updateRow: (lineId: string, patch: Partial<PlanningGridLine>) => void
  onSaveLine: (lineId: string, patch: PlanningLineFieldPatch) => void | Promise<boolean | void>
  onRemoveFromSelection: (lineId: string) => void
  onClearSelection: () => void
  onClose: () => void
}

export function PlanningBatchBuilderPanel({
  isOpen,
  lines,
  onCreateBatch,
  updateRow,
  onSaveLine,
  onRemoveFromSelection,
  onClearSelection,
  onClose,
}: Props) {
  const compatRows = useMemo(() => buildCompatibilityRows(lines), [lines])
  const hasAnyMixed = compatRows.some((r) => r.mixed)

  const totalQty = useMemo(
    () => lines.reduce((s, r) => s + (r.quantity || 0), 0),
    [lines],
  )

  if (!isOpen) return null
  if (lines.length < 2) return null

  const renderUpsField = true

  return (
    <SlideOverPanel
      isOpen={isOpen}
      onClose={onClose}
      title="Batch builder"
      backdropClassName="bg-ds-main/50 backdrop-blur-[1.5px]"
      panelClassName="border-l border-ds-line/80 bg-ds-card text-ds-ink shadow-2xl"
      zIndexClass="z-[60]"
      footer={
        <div className="space-y-2">
          {hasAnyMixed ? (
            <p className={`flex gap-1.5 text-[11px] leading-snug text-ds-warning ${mono}`}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Mixed configurations detected. This batch may require mixed tooling and additional setup.
              </span>
            </p>
          ) : null}
          <button
            type="button"
            onClick={onCreateBatch}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-ds-warning px-3 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-ds-warning/90"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create batch
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            className="w-full rounded-lg border border-input bg-background py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/10"
          >
            Clear selection
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-sm text-foreground" aria-label="Batch builder">
        <div className="flex items-center gap-2 text-ds-warning">
          <Layers className="h-4 w-4 shrink-0" aria-hidden />
          <p className={`text-xs text-ds-ink-faint ${mono}`}>
            {lines.length} job(s) selected · total qty {totalQty.toLocaleString('en-IN')}
          </p>
        </div>

        <div className="rounded-md border border-ds-line/40 bg-ds-elevated/25 px-3 py-2.5 text-xs">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Compatibility</p>
          <p className={`mt-1 text-[10px] text-ds-ink-muted ${mono}`}>
            All parameters for the selected jobs — Match means a single value; Mixed means variation (advisory only).
          </p>
          <ul className="mt-2 space-y-1.5">
            {compatRows.map((r) => (
              <li
                key={r.key}
                className={`leading-snug ${r.mixed ? 'text-ds-warning' : 'text-ds-success'}`}
              >
                {r.text}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Selected jobs</p>
          <ul className="max-h-[min(40vh,20rem)] space-y-2 overflow-y-auto overflow-x-hidden pr-0.5">
            {lines.map((r) => {
              const spec = (r.specOverrides || {}) as Record<string, unknown>
              const planCore = readPlanningCore(spec)
              const b = effectiveBatchStatus(planCore)
              const hasBatch = !!(planCore.masterSetId && planCore.mixSetMemberIds && planCore.mixSetMemberIds.length > 0)
              const meta = readPlanningMeta(spec)
              const rawUps = renderUpsField ? meta.ups : undefined
              const gangUpsStr =
                rawUps != null && Number(rawUps) >= 1 ? String(Math.floor(Number(rawUps))) : ''
              return (
                <li
                  key={r.id}
                  className="group flex items-start justify-between gap-2 rounded-md border border-ds-line/40 bg-background px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="truncate text-xs font-medium text-foreground" title={r.cartonName}>
                      {r.cartonName}
                    </p>
                    <p className={`truncate text-[10px] text-ds-ink-faint ${mono}`}>
                      {r.po.poNumber} · {r.quantity.toLocaleString('en-IN')} · {boardLabel(r)}
                    </p>
                    <div id={r.id === lines[0]?.id ? 'placement-ref' : undefined}>
                      <div id={r.id === lines[0]?.id ? 'fix-ups-render' : undefined}>
                      <label htmlFor={`ups-input-${r.id}`} id={r.id === lines[0]?.id ? 'label' : undefined} className="block text-[11px] font-medium text-ds-ink-muted">
                        Ups (per plate/output)
                      </label>
                      <div id={r.id === lines[0]?.id ? 'fix-ups-save' : undefined}>
                      <input
                        id={`ups-input-${r.id}`}
                        data-fix-ups-binding
                        type="number"
                        min={1}
                        step={1}
                        placeholder="Enter ups"
                        className={`ds-input mt-0.5 h-9 w-full max-w-[7rem] py-1.5 text-sm ${gangUpsStr ? 'border-ds-success/50 bg-ds-success/10' : ''}`}
                        value={gangUpsStr}
                        onChange={(e) => {
                          const v = e.target.value.trim()
                          if (v === '') {
                            const next = mergePlanningMetaUps(spec, null)
                            updateRow(r.id, { specOverrides: next })
                            return
                          }
                          const n = parseInt(v, 10)
                          if (!Number.isFinite(n) || n < 1) return
                          const next = mergePlanningMetaUps(spec, n)
                          updateRow(r.id, { specOverrides: next })
                        }}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          const n = v === '' ? null : parseInt(v, 10)
                          const next =
                            Number.isFinite(n) && (n as number) >= 1
                              ? mergePlanningMetaUps(spec, n as number)
                              : mergePlanningMetaUps(spec, null)
                          updateRow(r.id, { specOverrides: next })
                          void onSaveLine(r.id, { specOverrides: next })
                        }}
                      />
                      </div>
                      <p id={r.id === lines[0]?.id ? 'helper' : undefined} className="text-[10px] text-ds-ink-faint">
                        No. of repeats of this product in one gang layout
                      </p>
                      </div>
                    </div>
                    {hasBatch ? (
                      <span
                        className={`mt-0.5 inline-block rounded border px-1 py-0.5 text-[8px] font-bold ${
                          BATCH_STATUS_BADGE_CLASS[b]
                        }`}
                      >
                        {BATCH_STATUS_LABEL[b]}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemoveFromSelection(r.id)
                    }}
                    className="shrink-0 rounded p-0.5 text-ds-ink-faint transition-colors hover:bg-accent/20 hover:text-rose-300"
                    title="Remove from selection"
                    aria-label="Remove from selection"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </SlideOverPanel>
  )
}
