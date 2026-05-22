'use client'

import { memo, useCallback, useMemo } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { parseSheetSizeToPair } from '@/lib/planning-sheet-size'
import { deriveChildSizeMm, formatSizeMm } from '@/lib/planning-sheet-cut'
import {
  type RankedBoardMatch,
  type SmartMatchInput,
  rankBoardMatches,
} from '@/lib/planning-smart-match'
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
  /** Link the line to a board material — flows board type/GSM/size up into Board allocation. */
  onSelectBoard?: (materialId: string) => Promise<void>
}

const nf = new Intl.NumberFormat('en-IN')

type SubScore = { label: string; value: number }

const SubScoreBar = memo(function SubScoreBar({ label, value }: SubScore) {
  const pct = Math.max(0, Math.min(100, value))
  const tone =
    pct >= 75 ? 'bg-emerald-400/80' : pct >= 55 ? 'bg-amber-400/80' : 'bg-red-400/80'
  return (
    <div aria-label={`${label} sub-score ${Math.round(value)}`}>
      <div className="flex items-center justify-between text-[11px] text-ds-ink-faint mb-1">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(value)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-ds-elevated overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
})

function tierClass(tier: 'High' | 'Medium' | 'Low'): { pill: string; ring: string } {
  if (tier === 'High')
    return {
      pill: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      ring: 'border-emerald-500/30 bg-emerald-500/[0.04]',
    }
  if (tier === 'Medium')
    return {
      pill: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      ring: 'border-ds-line/40 bg-ds-elevated/40',
    }
  return {
    pill: 'bg-red-500/15 text-red-300 border-red-500/30',
    ring: 'border-ds-line/40 bg-ds-elevated/40',
  }
}

function statusClass(status: PlanningEngineBoardOption['status']): { pill: string; ring: string } {
  if (status === 'Ready')
    return {
      pill: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      ring: 'border-emerald-500/30 bg-emerald-500/[0.04]',
    }
  if (status === 'Partial')
    return {
      pill: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      ring: 'border-amber-500/40 bg-amber-500/[0.04]',
    }
  return {
    pill: 'bg-red-500/15 text-red-300 border-red-500/30',
    ring: 'border-ds-line/40 bg-ds-elevated/40',
  }
}

type EmptyKind = 'spec-incomplete' | 'no-material' | 'no-stock' | 'unknown'

function deriveEmptyState(
  line: PlanningEngineLine,
  readiness: PlanningEngineReadiness | null,
): { kind: EmptyKind; title: string; detail: string; cta: string | null } {
  const bsi = line.planningLedger?.boardStockInsight
  if (bsi?.specComplete === false) {
    return {
      kind: 'spec-incomplete',
      title: 'Spec incomplete — matches blocked',
      detail:
        bsi.specIncompleteReason ||
        'Carton spec is missing required fields. Complete the spec pack to unlock board matches.',
      cta: 'Fix in UPS & sheet spec ↓',
    }
  }
  if (!readiness || (!readiness.materialId && !readiness.materialCode)) {
    return {
      kind: 'no-material',
      title: 'No material linked',
      detail: 'Link a board material in the status bar above to see ranked stock matches.',
      cta: null,
    }
  }
  return {
    kind: 'no-stock',
    title: 'No matching board in current stock',
    detail:
      'Warehouse has no sheets that fit this spec. See Suggested procurement in Board allocation for the recommended PR.',
    cta: 'See Suggested procurement ↑',
  }
}

const SmartMatchEmptyState = memo(function SmartMatchEmptyState({
  line,
  readiness,
}: {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
}) {
  const empty = deriveEmptyState(line, readiness)
  const tone =
    empty.kind === 'spec-incomplete'
      ? 'border-amber-500/40 bg-amber-500/[0.06]'
      : 'border-ds-line bg-ds-elevated/60'
  const titleTone = empty.kind === 'spec-incomplete' ? 'text-amber-300' : 'text-ds-ink'
  return (
    <div className={`rounded-ds-md border ${tone} px-4 py-3.5`}>
      <div className={`text-sm font-semibold ${titleTone}`}>{empty.title}</div>
      <div className="mt-1 text-xs text-ds-ink-muted leading-relaxed">{empty.detail}</div>
      {empty.cta ? (
        <div className="mt-2 text-[11px] font-medium uppercase tracking-wider text-ds-ink-faint">
          {empty.cta}
        </div>
      ) : null}
    </div>
  )
})

function scoreTone(score: number): string {
  return score >= 75
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : score >= 55
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : 'bg-red-500/15 text-red-300 border-red-500/30'
}

const BoardOptionCard = memo(function BoardOptionCard({
  match,
  selected,
  onSelect,
}: {
  match: RankedBoardMatch
  selected: boolean
  onSelect?: (materialId: string) => void
}) {
  const t = statusClass(match.status)
  const boardLabel =
    [match.boardType, match.gsm != null ? `${match.gsm} gsm` : null].filter(Boolean).join(' · ') ||
    match.materialCode ||
    'Board'

  const parentPair = match.size ? parseSheetSizeToPair(match.size) : null
  const child =
    parentPair && match.cutsPerSheet > 0
      ? deriveChildSizeMm(parentPair.length, parentPair.width, match.cutsPerSheet)
      : null
  const parentLabel = parentPair ? formatSizeMm(parentPair.length, parentPair.width) : match.size ?? '—'
  const childLabel = child ? formatSizeMm(child.lengthMm, child.widthMm) : '—'
  const surplus = match.freeSheets - match.requiredParentSheets

  const clickable = !!onSelect && !!match.materialId

  return (
    <div
      className={`rounded-ds-md border p-3.5 ${t.ring}${
        clickable ? ' cursor-pointer hover:border-ds-brand/50 transition-colors' : ''
      }${selected ? ' ring-2 ring-ds-brand/60' : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-pressed={clickable ? selected : undefined}
      aria-label={clickable ? `Select board ${boardLabel}` : undefined}
      onClick={clickable ? () => onSelect?.(match.materialId) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect?.(match.materialId)
              }
            }
          : undefined
      }
    >
      {/* Header: rank + bucket, match score, status */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
            #{match.rank} · {match.bucketLabel}
          </div>
          <div className="text-sm font-semibold text-ds-ink truncate">{boardLabel}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${scoreTone(match.matchScore)}`}
            aria-label={`Match score ${Math.round(match.matchScore)} percent`}
          >
            {Math.round(match.matchScore)}%
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${t.pill}`}
          >
            {match.status}
          </span>
        </div>
      </div>

      {/* Parent → child sizing */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ds-ink-faint mb-1.5 tabular-nums">
        <span className="text-ds-ink-muted">{parentLabel}</span>
        {match.cutsPerSheet > 0 ? (
          <>
            <span className="rounded-ds-sm border border-ds-line/40 bg-ds-elevated px-1.5 py-0.5 text-[10px]">
              {match.cutsPerSheet}-cut
            </span>
            <span aria-hidden>→</span>
            <span className="text-ds-ink-muted">{childLabel}</span>
          </>
        ) : null}
      </div>

      {/* Stock vs requirement */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ds-ink-faint mb-2 tabular-nums">
        <span>{nf.format(Math.round(match.freeSheets))} free</span>
        <span>·</span>
        <span>Need {nf.format(Math.round(match.requiredParentSheets))}</span>
        <span>·</span>
        {match.shortageParentSheets > 0 ? (
          <span className="text-red-300">Short {nf.format(Math.round(match.shortageParentSheets))}</span>
        ) : (
          <span className="text-emerald-300">+{nf.format(Math.round(Math.max(0, surplus)))} surplus</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <SubScoreBar label="Yield" value={match.yieldPct} />
        <SubScoreBar label={`Waste ${Math.round(match.wastagePct)}%`} value={Math.max(0, 100 - match.wastagePct)} />
      </div>

      {/* Reason */}
      <div className="mt-2 text-[11px] text-ds-ink-muted leading-snug">{match.reason}</div>

      {match.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {match.tags.slice(0, 5).map((tag) => (
            <span
              key={tag}
              className="rounded-ds-sm border border-ds-line/40 bg-ds-elevated px-1.5 py-0.5 text-[11px] text-ds-ink-faint"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
})

export const SectionSmartMatch = memo(function SectionSmartMatch({
  line,
  readiness,
  onPatch: _onPatch,
  onSelectBoard,
}: Props) {
  const scored = line.smartMatch?.suggestions ?? []
  const matchedOn = line.smartMatch?.matchedOn ?? null
  const materialCode = line.smartMatch?.materialCode ?? readiness?.materialCode ?? null
  const confidence = line.smartMatch?.boardMatchConfidence ?? null

  // Memoised — avoid re-deriving on every parent render
  const boardOptions = useMemo(() => {
    const strict = readiness?.suggestedBoardOptions ?? []
    const fallback = readiness?.closestAvailableOptions ?? []
    return strict.length > 0 ? strict : fallback
  }, [readiness])

  const usingFallback = useMemo(
    () =>
      (readiness?.suggestedBoardOptions?.length ?? 0) === 0 &&
      (readiness?.closestAvailableOptions?.length ?? 0) > 0,
    [readiness],
  )

  // Rank the readiness board options into labelled buckets with match scores.
  const rankedMatches = useMemo<RankedBoardMatch[]>(
    () =>
      rankBoardMatches(
        boardOptions.map(
          (o) =>
            ({
              materialId: o.materialId,
              materialCode: o.materialCode,
              boardType: o.boardType,
              gsm: o.gsm,
              size: o.size,
              freeSheets: o.freeSheets,
              requiredParentSheets: o.requiredParentSheets,
              shortageParentSheets: o.shortageParentSheets,
              wastagePct: o.wastagePct,
              yieldPct: o.yieldPct,
              cutsPerSheet: o.cutsPerSheet,
              matchType: o.matchType,
              status: o.status,
              gsmDelta: o.gsmDelta,
              tags: o.tags,
              boardMatchMode:
                (o as { boardMatchMode?: 'exact' | 'cross_field' | 'fallback' | null }).boardMatchMode ??
                null,
            }) satisfies SmartMatchInput,
        ),
      ),
    [boardOptions],
  )

  const selectedMaterialId = readiness?.materialId ?? null

  // Stable callback — won't cause BoardOptionCard to re-render on every parent render
  const handleSelect = useCallback(
    (materialId: string) => {
      void onSelectBoard?.(materialId)
    },
    [onSelectBoard],
  )

  return (
    <CardSection title="SMART MATCH">
      <div className="flex items-center justify-between text-xs text-ds-ink-faint mb-2.5">
        <span>
          {boardOptions.length > 0
            ? `${boardOptions.length} board ${boardOptions.length === 1 ? 'match' : 'matches'}${usingFallback ? ' · compatible' : ''}${
                onSelectBoard && scored.length === 0 ? ' · tap to link' : ''
              }`
            : ''}
        </span>
        <span>
          {[readiness?.boardType, readiness?.gsm ? `${readiness.gsm}g` : null]
            .filter(Boolean)
            .join(' · ') || '—'}
        </span>
      </div>

      {scored.length > 0 ? (
        <div className="space-y-3">
          {scored.slice(0, 3).map((s, idx) => {
            const t = tierClass(s.tier)
            return (
              <div key={`${s.label}-${idx}`} className={`rounded-ds-md border p-3.5 ${t.ring}`}>
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ds-ink">Suggestion {s.label}</div>
                    <div className="text-xs text-ds-ink-faint truncate">
                      {s.poRefs.join(' · ')} + this line
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${t.pill}`}
                  >
                    {s.tier} · <span className="tabular-nums">{s.composite.toFixed(1)}</span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ds-ink-faint mb-2 tabular-nums">
                  <span>{s.linesIncluded} lines</span>
                  <span>·</span>
                  <span>{nf.format(s.totalPcs)} pcs</span>
                  <span>·</span>
                  <span>Avg yield {s.avgYieldPct.toFixed(1)}%</span>
                  <span>·</span>
                  <span>~{nf.format(s.totalSheets)} sh</span>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <SubScoreBar label="Size" value={s.sizeScore} />
                  <SubScoreBar label="Waste" value={s.wasteScore} />
                  <SubScoreBar label="Urgency" value={s.urgencyScore} />
                  <SubScoreBar label="Tool" value={s.toolScore} />
                </div>
              </div>
            )
          })}
        </div>
      ) : rankedMatches.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {rankedMatches.map((match) => (
            <BoardOptionCard
              key={match.materialId}
              match={match}
              selected={!!selectedMaterialId && match.materialId === selectedMaterialId}
              onSelect={onSelectBoard ? handleSelect : undefined}
            />
          ))}
        </div>
      ) : (
        <SmartMatchEmptyState line={line} readiness={readiness} />
      )}

      {confidence != null ? (
        <div className="mt-3 rounded-ds-md border border-ds-line/40 bg-ds-elevated/40 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              Board match confidence
            </div>
            <span className="text-emerald-300 text-sm font-semibold tabular-nums">
              {Math.round(confidence * 100)}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-ds-elevated overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-400/80"
              style={{ width: `${Math.max(0, Math.min(100, confidence * 100))}%` }}
            />
          </div>
          {matchedOn || materialCode ? (
            <div className="mt-2 text-xs text-ds-ink-faint">
              {matchedOn ? `Matched on ${matchedOn}` : 'Match basis pending'}
              {materialCode ? ` — material code ${materialCode}` : ''}
            </div>
          ) : null}
        </div>
      ) : null}
    </CardSection>
  )
})
