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

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  onPatch: SectionPatchFn
}

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

function mappingLabel(strategy: string | undefined): string {
  switch (strategy) {
    case 'strict': return 'Strict match'
    case 'fallback_without_classification': return 'Without-classification match'
    case 'fallback_wider_gsm_tolerance': return 'GSM-tolerance match'
    case 'closest_only': return 'Closest available'
    default: return '—'
  }
}

function statusTone(status: PlanningEngineBoardOption['status']): 'success' | 'warning' | 'danger' {
  if (status === 'Ready') return 'success'
  if (status === 'Partial') return 'warning'
  return 'danger'
}

function fitTone(fit: number): string {
  if (fit >= 75) return 'text-emerald-300'
  if (fit >= 55) return 'text-amber-300'
  return 'text-red-300'
}

function boardModeLabel(mode: PlanningEngineBoardOption['boardMatchMode']): string {
  if (mode === 'exact') return 'Board exact'
  if (mode === 'cross_field') return 'Board mapped'
  return 'Board fallback'
}

function OptionCard({
  opt,
  rank,
  best,
  fallback,
  gsmTolerance,
  onUse,
  busy,
}: {
  opt: PlanningEngineBoardOption
  rank: number
  best: boolean
  fallback: boolean
  gsmTolerance: number
  onUse: () => void
  busy: boolean
}) {
  const fit = Math.round(opt.fitScore ?? 0)
  return (
    <div
      className={
        best
          ? 'rounded-ds-md border border-emerald-500/40 bg-emerald-500/[0.06] p-3'
          : 'rounded-ds-md border border-ds-line/50 bg-ds-elevated/60 p-3'
      }
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
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
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge tone={statusTone(opt.status)} className="text-[9px]">{opt.status}</Badge>
          <span className={`text-xs font-semibold tabular-nums ${fitTone(fit)}`}>Fit {fit}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {(opt.tags ?? []).map((tag) => (
          <span
            key={tag}
            title={TAG_WHY[tag] ?? tag}
            className="rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 px-1.5 py-0.5 text-[9px] font-medium"
          >
            {tag}
          </span>
        ))}
        <span className="text-[9px] text-ds-ink-faint">{opt.matchType}</span>
        <span className="text-[9px] text-ds-ink-faint">{boardModeLabel(opt.boardMatchMode)}</span>
        {fallback ? (
          <span className="text-[9px] text-amber-300">Not ideal — check manually</span>
        ) : null}
      </div>

      {/* Requirement + waste mapping (previous logic) */}
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

      <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-ds-line/30">
        <div className="text-[11px] text-ds-ink-faint tabular-nums">
          Avail <span className="text-ds-ink">{nf.format(opt.availableSheets)}</span>
          {' · '}Rsvd <span className="text-ds-ink">{nf.format(opt.reservedSheets)}</span>
          {' · '}Free <span className="text-ds-ink">{nf.format(opt.freeSheets)}</span>
        </div>
        <button
          type="button"
          onClick={onUse}
          disabled={busy}
          className="shrink-0 rounded-ds-sm border border-ds-brand/40 bg-ds-brand/10 px-2.5 py-1 text-[11px] font-semibold text-ds-brand hover:bg-ds-brand/20 disabled:opacity-50 transition-colors"
        >
          {busy ? 'Applying…' : 'Use board'}
        </button>
      </div>
    </div>
  )
}

export function SectionSmartMatch({ line, readiness, onPatch }: Props) {
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

  return (
    <CardSection title="SMART MATCH">
      {/* Requirement + mapping diagnostics (ported from previous logic) */}
      <div className="rounded-ds-md border border-ds-line/40 bg-ds-elevated/40 p-2.5 mb-2 text-[11px]">
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
        <div className="rounded-ds-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
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
            <div className="mb-2 rounded-ds-sm border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
              {readiness.debugMessage}
            </div>
          ) : null}
          <div className="space-y-2">
            {primary.slice(0, 5).map((opt, idx) => (
              <OptionCard
                key={opt.materialId}
                opt={opt}
                rank={opt.matchRank ?? idx + 1}
                best={idx === 0 && !isFallback}
                fallback={isFallback}
                gsmTolerance={gsmTol}
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
              {alternatives.slice(0, 5).map((opt, idx) => (
                <OptionCard
                  key={opt.materialId}
                  opt={opt}
                  rank={opt.matchRank ?? idx + 1}
                  best={false}
                  fallback
                  gsmTolerance={gsmTol}
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
