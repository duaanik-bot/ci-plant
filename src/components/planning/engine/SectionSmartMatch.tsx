'use client'

import { useState } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import type {
  PlanningEngineBoardOption,
  PlanningEngineLine,
  PlanningEngineReadiness,
  SectionPatchFn,
} from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  onPatch: SectionPatchFn
  onSelectBoard?: (materialId: string) => Promise<void>
  /** Render as compact sidebar cards (circular score badge, select button) */
  sidebar?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-IN')

const TAG_WHY: Record<string, string> = {
  'Best Yield': 'Highest cuts per parent sheet',
  'Lowest Wastage': 'Lowest waste area among candidates',
  'Closest GSM': 'Closest GSM to requested spec',
  'Leftover Reuse': 'Reuses leftover / offcut with strong fit',
  'Leftover Stock': 'Uses leftover stock',
  'Most Available': 'Best free stock availability',
  'Exact Match': 'Exact size + GSM match',
}

const TAG_COLORS: Record<string, string> = {
  'Best Yield': 'bg-emerald-500/10 text-emerald-300',
  'Lowest Wastage': 'bg-blue-500/10 text-blue-300',
  'Exact Match': 'bg-violet-500/10 text-violet-300',
  'Most Available': 'bg-sky-500/10 text-sky-300',
  'Closest GSM': 'bg-amber-500/10 text-amber-300',
  'Leftover Stock': 'bg-orange-500/10 text-orange-300',
  'Leftover Reuse': 'bg-rose-500/10 text-rose-300',
}

function mappingLabel(strategy: string | undefined): string {
  switch (strategy) {
    case 'strict': return 'Strict match'
    case 'fallback_without_classification': return 'Without-classification match'
    case 'fallback_wider_gsm_tolerance': return 'GSM-tolerance match'
    case 'closest_only': return 'Closest available'
    default: return '—'
  }
}

function mappingLabelShort(strategy: string | undefined): string {
  switch (strategy) {
    case 'strict': return 'Strict'
    case 'fallback_without_classification': return 'No-class'
    case 'fallback_wider_gsm_tolerance': return 'GSM-tol'
    case 'closest_only': return 'Closest'
    default: return '—'
  }
}

function statusTone(status: PlanningEngineBoardOption['status']): 'success' | 'warning' | 'danger' {
  if (status === 'Ready') return 'success'
  if (status === 'Partial') return 'warning'
  return 'danger'
}

function fitColor(fit: number): { ring: string; bg: string; text: string } {
  if (fit >= 75) return { ring: 'stroke-emerald-400', bg: 'bg-emerald-500/10', text: 'text-emerald-300' }
  if (fit >= 55) return { ring: 'stroke-amber-400', bg: 'bg-amber-500/10', text: 'text-amber-300' }
  return { ring: 'stroke-red-400', bg: 'bg-red-500/10', text: 'text-red-300' }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Circular score badge (SVG donut ring) */
function ScoreBadge({ score, size = 48 }: { score: number; size?: number }) {
  const r = (size - 6) / 2
  const circ = 2 * Math.PI * r
  const filled = (score / 100) * circ
  const colors = fitColor(score)
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="rotate-[-90deg]" style={{ display: 'block' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none"
          className={colors.ring}
          strokeWidth="4"
          strokeDasharray={`${filled} ${circ - filled}`}
          strokeLinecap="round"
        />
      </svg>
      <span
        className={[
          'absolute inset-0 flex items-center justify-center text-[11px] font-black tabular-nums leading-none',
          colors.text,
        ].join(' ')}
        style={{ fontSize: size < 44 ? 9 : 11 }}
      >
        {score}
      </span>
    </div>
  )
}

/** Sidebar compact card */
function SidebarCard({
  opt,
  rank,
  fallback,
  gsmTolerance,
  isSelected,
  onUse,
  busy,
}: {
  opt: PlanningEngineBoardOption
  rank: number
  fallback: boolean
  gsmTolerance: number
  isSelected: boolean
  onUse: () => void
  busy: boolean
}) {
  const fit = Math.round(opt.fitScore ?? 0)
  const colors = fitColor(fit)

  return (
    <div
      className={[
        'rounded-ds-md p-3 border transition-all',
        isSelected
          ? 'bg-emerald-500/[0.06] border-emerald-500/25'
          : 'bg-ds-elevated/50 border-ds-line/20 hover:border-ds-line/40',
      ].join(' ')}
    >
      <div className="flex items-start gap-2.5">
        {/* Circular score */}
        <ScoreBadge score={fit} size={44} />

        {/* Board info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1 mb-0.5">
            <span className="text-xs font-semibold text-ds-ink truncate">{opt.materialCode}</span>
            <span className="text-[10px] text-ds-ink-faint shrink-0">#{rank}</span>
          </div>
          <div className="text-[11px] text-ds-ink-faint truncate">
            {opt.size} · {opt.gsm ?? '—'} GSM
            {opt.gsmDelta != null && opt.gsmDelta !== 0
              ? ` (Δ${opt.gsmDelta > 0 ? '+' : ''}${opt.gsmDelta})`
              : ''}
          </div>
          <div className="text-[11px] text-ds-ink-faint">{opt.orientation}</div>
        </div>
      </div>

      {/* Tags */}
      {(opt.tags ?? []).length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-2">
          {(opt.tags ?? []).map((tag) => (
            <span
              key={tag}
              title={TAG_WHY[tag] ?? tag}
              className={[
                'rounded-full px-1.5 py-0.5 text-[9px] font-semibold',
                TAG_COLORS[tag] ?? 'bg-ds-elevated text-ds-ink-faint',
              ].join(' ')}
            >
              {tag}
            </span>
          ))}
          {fallback ? (
            <span className="text-[9px] text-amber-300">· Not ideal</span>
          ) : null}
        </div>
      ) : null}

      {/* Stats row */}
      <div className="flex items-center gap-3 mt-2 text-[11px] text-ds-ink-faint tabular-nums">
        <span>Yield <span className="text-ds-ink font-medium">{opt.cutsPerSheet}</span></span>
        <span>Waste <span className="text-ds-ink font-medium">{opt.wastagePct.toFixed(1)}%</span></span>
        <span>Free <span className="text-ds-ink font-medium">{nf.format(opt.freeSheets)}</span></span>
      </div>

      {/* GSM tolerance */}
      {opt.gsmDelta != null && opt.gsmDelta !== 0 ? (
        <div className="mt-1 text-[10px] text-ds-ink-faint/70">
          ±{gsmTolerance} GSM tolerance
        </div>
      ) : null}

      {/* Shortage warning */}
      {opt.shortageParentSheets > 0 ? (
        <div className="mt-1.5 rounded-ds-sm bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          Short {nf.format(opt.shortageParentSheets)} sh
        </div>
      ) : null}

      {/* Action row */}
      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-ds-line/15">
        <Badge tone={statusTone(opt.status)} className="text-[9px]">{opt.status}</Badge>
        <button
          type="button"
          onClick={onUse}
          disabled={busy}
          className={[
            'rounded-ds-sm px-2.5 py-1 text-[11px] font-semibold transition-all disabled:opacity-50',
            isSelected
              ? 'bg-emerald-500/20 text-emerald-300 cursor-default'
              : 'bg-ds-brand/10 text-ds-brand hover:bg-ds-brand/20',
          ].join(' ')}
        >
          {isSelected ? '✓ Selected' : busy ? 'Applying…' : 'Select'}
        </button>
      </div>
    </div>
  )
}

/** Full-size card for default (main content) mode */
function OptionCard({
  opt,
  rank,
  best,
  fallback,
  gsmTolerance,
  isSelected,
  onUse,
  busy,
}: {
  opt: PlanningEngineBoardOption
  rank: number
  best: boolean
  fallback: boolean
  gsmTolerance: number
  isSelected: boolean
  onUse: () => void
  busy: boolean
}) {
  const fit = Math.round(opt.fitScore ?? 0)
  const colors = fitColor(fit)

  return (
    <div
      className={[
        'rounded-ds-md p-3',
        best
          ? 'bg-emerald-500/[0.06] ring-1 ring-emerald-500/25'
          : 'bg-ds-elevated/60',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="min-w-0 flex items-start gap-2.5">
          <ScoreBadge score={fit} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold text-ds-ink-faint">#{rank}</span>
              <span className="text-xs font-semibold text-ds-ink truncate">{opt.materialCode}</span>
            </div>
            <div className="text-[11px] text-ds-ink-faint truncate">
              {opt.size} · {opt.gsm ?? '—'} GSM
              {opt.gsmDelta != null && opt.gsmDelta !== 0
                ? ` (Δ ${opt.gsmDelta > 0 ? '+' : ''}${opt.gsmDelta} / ±${gsmTolerance})`
                : ''}
              {' · '}{opt.orientation}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge tone={statusTone(opt.status)} className="text-[9px]">{opt.status}</Badge>
          <span className={`text-xs font-semibold tabular-nums ${colors.text}`}>Fit {fit}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {(opt.tags ?? []).map((tag) => (
          <span
            key={tag}
            title={TAG_WHY[tag] ?? tag}
            className={[
              'rounded-full px-1.5 py-0.5 text-[9px] font-semibold',
              TAG_COLORS[tag] ?? 'bg-ds-elevated text-ds-ink-faint',
            ].join(' ')}
          >
            {tag}
          </span>
        ))}
        <span className="text-[9px] text-ds-ink-faint">{opt.matchType}</span>
        {fallback ? (
          <span className="text-[9px] text-amber-300">Not ideal — check manually</span>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px] text-ds-ink-faint mb-2 tabular-nums">
        <span>Cuts/sheet <span className="text-ds-ink">{opt.cutsPerSheet}</span></span>
        <span>Req parent <span className="text-ds-ink">{nf.format(opt.requiredParentSheets)}</span></span>
        <span>Wastage <span className="text-ds-ink">{opt.wastagePct.toFixed(1)}%</span></span>
        <span>Yield <span className="text-ds-ink">{opt.yieldPct.toFixed(1)}%</span></span>
        <span>Size dev <span className="text-ds-ink">{Number(opt.sizeDeviationPct ?? 0).toFixed(2)}%</span></span>
        {opt.shortageParentSheets > 0 ? (
          <span className="text-red-300">Short {nf.format(opt.shortageParentSheets)}</span>
        ) : <span />}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1.5">
        <div className="text-[11px] text-ds-ink-faint tabular-nums">
          Avail <span className="text-ds-ink">{nf.format(opt.availableSheets)}</span>
          {' · '}Rsvd <span className="text-ds-ink">{nf.format(opt.reservedSheets)}</span>
          {' · '}Free <span className="text-ds-ink">{nf.format(opt.freeSheets)}</span>
        </div>
        <button
          type="button"
          onClick={onUse}
          disabled={busy}
          className={[
            'shrink-0 rounded-ds-sm px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50',
            isSelected
              ? 'bg-emerald-500/15 text-emerald-300 cursor-default'
              : 'bg-ds-brand/10 text-ds-brand hover:bg-ds-brand/20',
          ].join(' ')}
        >
          {isSelected ? '✓ Selected' : busy ? 'Applying…' : 'Use board'}
        </button>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SectionSmartMatch({ line, readiness, onPatch, sidebar = false }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showAlternatives, setShowAlternatives] = useState(false)

  const strict = readiness?.suggestedBoardOptions ?? []
  const closest = readiness?.closestAvailableOptions ?? []
  const primary = strict.length > 0 ? strict : closest
  const alternatives = strict.length > 0 ? closest : []
  const isFallback = strict.length === 0
  const gsmTol = readiness?.gsmTolerance ?? 10

  const ms = readiness?.mappingSafety
  const dbg = readiness?.suggestionDebug

  // Currently selected material
  const selectedMaterialId =
    (line.specOverrides as Record<string, unknown> | undefined)?.selectedBoardMaterialId as string | undefined

  const apply = async (opt: PlanningEngineBoardOption) => {
    setBusyId(opt.materialId)
    try {
      await onPatch({
        specOverrides: {
          ...(line.specOverrides ?? {}),
          selectedBoardMaterialId: opt.materialId,
          selectedBoardMaterialCode: opt.materialCode,
          selectedBoardSize: opt.size,
        },
      })
    } finally {
      setBusyId(null)
    }
  }

  const maxShown = sidebar ? 3 : 5

  // ── Sidebar render ───────────────────────────────────────────────────────

  if (sidebar) {
    return (
      <div>
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-ds-ink-faint">
            Smart Match
          </div>
          <div className="text-[10px] text-ds-ink-faint tabular-nums">
            {mappingLabelShort(ms?.strategyUsed)}
            {ms?.strictPoolCount != null ? ` · ${ms.strictPoolCount} strict` : ''}
          </div>
        </div>

        {/* Debug funnel (tiny) */}
        {dbg ? (
          <div className="mb-2 text-[10px] text-ds-ink-faint/70 tabular-nums">
            {dbg.materialsFetched}→{dbg.afterGsmFilter}→{dbg.afterSizeFit}→{dbg.finalSuggestions} candidates
          </div>
        ) : null}

        {primary.length === 0 ? (
          <div className="rounded-ds-md bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
            <div className="font-semibold">
              {readiness?.noMaterialsAtAll
                ? 'No materials in Paper Warehouse.'
                : readiness?.materialMatchState === 'none'
                  ? 'No suitable material found.'
                  : 'No suitable stock — raise a PR.'}
            </div>
            {readiness?.debugMessage ? (
              <div className="text-amber-200/80 text-[11px]">{readiness.debugMessage}</div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {readiness?.debugMessage ? (
              <div className="rounded-ds-sm bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                {readiness.debugMessage}
              </div>
            ) : null}

            {primary.slice(0, maxShown).map((opt, idx) => (
              <SidebarCard
                key={opt.materialId}
                opt={opt}
                rank={opt.matchRank ?? idx + 1}
                fallback={isFallback}
                gsmTolerance={gsmTol}
                isSelected={selectedMaterialId === opt.materialId}
                busy={busyId === opt.materialId}
                onUse={() => { void apply(opt) }}
              />
            ))}

            {primary.length > maxShown ? (
              <button
                type="button"
                className="w-full text-center text-[11px] font-medium text-ds-brand hover:underline py-1"
                onClick={() => setShowAlternatives((v) => !v)}
              >
                {showAlternatives
                  ? 'Show fewer'
                  : `View all ${primary.length} suggestions →`}
              </button>
            ) : null}

            {showAlternatives ? (
              <div className="space-y-2">
                {primary.slice(maxShown).map((opt, idx) => (
                  <SidebarCard
                    key={opt.materialId}
                    opt={opt}
                    rank={opt.matchRank ?? maxShown + idx + 1}
                    fallback={isFallback}
                    gsmTolerance={gsmTol}
                    isSelected={selectedMaterialId === opt.materialId}
                    busy={busyId === opt.materialId}
                    onUse={() => { void apply(opt) }}
                  />
                ))}
              </div>
            ) : null}

            {alternatives.length > 0 ? (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowAlternatives((v) => !v)}
                  className="text-[11px] font-medium text-ds-ink-faint hover:text-ds-brand"
                >
                  {alternatives.length} compatible alternative{alternatives.length > 1 ? 's' : ''} →
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  // ── Default (full-width) render ──────────────────────────────────────────

  return (
    <CardSection title="SMART MATCH">
      {/* Requirement + mapping diagnostics */}
      <div className="rounded-ds-md bg-ds-elevated/40 p-2.5 mb-2 text-[11px]">
        <div className="flex items-center justify-between text-ds-ink">
          <span className="font-medium">
            {[readiness?.boardType, readiness?.gsm ? `${readiness.gsm}g` : null, readiness?.size]
              .filter(Boolean)
              .join(' · ') || 'Requirement —'}
          </span>
          <span className="text-ds-ink-faint">
            Mapping: {mappingLabel(ms?.strategyUsed)}
          </span>
        </div>
        <div className="mt-1 text-ds-ink-faint tabular-nums">
          candidates {ms?.candidatePoolCount ?? 0} · strict {ms?.strictPoolCount ?? 0}
          {dbg
            ? ` · funnel ${dbg.materialsFetched}→${dbg.afterGsmFilter}→${dbg.afterSizeFit}→${dbg.finalSuggestions}`
            : ''}
        </div>
      </div>

      {primary.length === 0 ? (
        <div className="rounded-ds-md bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
          <div className="font-semibold">
            {readiness?.noMaterialsAtAll
              ? 'No materials exist in Paper Warehouse yet.'
              : readiness?.materialMatchState === 'none'
                ? 'No suitable material found for this size / GSM.'
                : 'No suitable stock found — raise a PR.'}
          </div>
          {readiness?.debugMessage ? (
            <div className="text-amber-200/80">{readiness.debugMessage}</div>
          ) : null}
          <div className="text-amber-200/70">
            Required {nf.format(readiness?.requiredSheets ?? 0)} sheets · shortfall{' '}
            {nf.format(readiness?.shortageSheets ?? 0)} sheets.
          </div>
        </div>
      ) : (
        <>
          {readiness?.debugMessage ? (
            <div className="mb-2 rounded-ds-sm bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
              {readiness.debugMessage}
            </div>
          ) : null}
          <div className="space-y-2">
            {primary.slice(0, maxShown).map((opt, idx) => (
              <OptionCard
                key={opt.materialId}
                opt={opt}
                rank={opt.matchRank ?? idx + 1}
                best={idx === 0 && !isFallback}
                fallback={isFallback}
                gsmTolerance={gsmTol}
                isSelected={selectedMaterialId === opt.materialId}
                busy={busyId === opt.materialId}
                onUse={() => { void apply(opt) }}
              />
            ))}
          </div>
        </>
      )}

      {alternatives.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowAlternatives((v) => !v)}
            className="text-[11px] font-medium text-ds-brand hover:underline"
          >
            {showAlternatives ? 'Hide' : 'Show'} {alternatives.length} compatible alternative
            {alternatives.length > 1 ? 's' : ''}
          </button>
          {showAlternatives ? (
            <div className="mt-2 space-y-2">
              {alternatives.slice(0, maxShown).map((opt, idx) => (
                <OptionCard
                  key={opt.materialId}
                  opt={opt}
                  rank={opt.matchRank ?? idx + 1}
                  best={false}
                  fallback
                  gsmTolerance={gsmTol}
                  isSelected={selectedMaterialId === opt.materialId}
                  busy={busyId === opt.materialId}
                  onUse={() => { void apply(opt) }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </CardSection>
  )
}
