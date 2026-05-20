'use client'

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

type SubScore = { label: string; value: number }

function SubScoreBar({ label, value }: SubScore) {
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
}

function tierClass(tier: 'High' | 'Medium' | 'Low'): { pill: string; ring: string } {
  if (tier === 'High') return {
    pill: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    ring: 'border-emerald-500/30 bg-emerald-500/[0.04]',
  }
  if (tier === 'Medium') return {
    pill: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    ring: 'border-ds-line/40 bg-ds-elevated/40',
  }
  return {
    pill: 'bg-red-500/15 text-red-300 border-red-500/30',
    ring: 'border-ds-line/40 bg-ds-elevated/40',
  }
}

function statusClass(status: PlanningEngineBoardOption['status']): { pill: string; ring: string } {
  if (status === 'Ready') return {
    pill: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    ring: 'border-emerald-500/30 bg-emerald-500/[0.04]',
  }
  if (status === 'Partial') return {
    pill: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    ring: 'border-amber-500/40 bg-amber-500/[0.04]',
  }
  return {
    pill: 'bg-red-500/15 text-red-300 border-red-500/30',
    ring: 'border-ds-line/40 bg-ds-elevated/40',
  }
}

function BoardOptionCard({ opt, rank }: { opt: PlanningEngineBoardOption; rank: number }) {
  const t = statusClass(opt.status)
  const boardLabel = [opt.boardType, opt.gsm != null ? `${opt.gsm} gsm` : null]
    .filter(Boolean)
    .join(' · ') || opt.materialCode

  return (
    <div className={`rounded-ds-md border p-3.5 ${t.ring}`}>
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ds-ink truncate">
            #{rank} · {boardLabel}
          </div>
          <div className="text-xs text-ds-ink-faint truncate">
            {opt.size} · {opt.matchType}
            {opt.gsmDelta != null && opt.gsmDelta !== 0
              ? ` · ${opt.gsmDelta > 0 ? '+' : ''}${opt.gsmDelta}g`
              : ''}
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${t.pill}`}
        >
          {opt.status}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ds-ink-faint mb-2 tabular-nums">
        <span>{nf.format(Math.round(opt.freeSheets))} free sh</span>
        <span>·</span>
        <span>Need {nf.format(Math.round(opt.requiredParentSheets))} sh</span>
        {opt.shortageParentSheets > 0 ? (
          <>
            <span>·</span>
            <span className="text-red-300">
              Short {nf.format(Math.round(opt.shortageParentSheets))} sh
            </span>
          </>
        ) : null}
        {opt.cutsPerSheet > 0 ? (
          <>
            <span>·</span>
            <span>{opt.cutsPerSheet}-up</span>
          </>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <SubScoreBar label="Yield" value={opt.yieldPct} />
        <SubScoreBar label="No-waste" value={Math.max(0, 100 - opt.wastagePct)} />
      </div>

      {opt.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {opt.tags.slice(0, 4).map((tag) => (
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
}

export function SectionSmartMatch({ line, readiness, onPatch: _onPatch }: Props) {
  const scored = line.smartMatch?.suggestions ?? []
  const matchedOn = line.smartMatch?.matchedOn ?? null
  const materialCode = line.smartMatch?.materialCode ?? readiness?.materialCode ?? null
  const confidence = line.smartMatch?.boardMatchConfidence ?? null

  const strictOptions = readiness?.suggestedBoardOptions ?? []
  const fallbackOptions = readiness?.closestAvailableOptions ?? []
  const boardOptions = strictOptions.length > 0 ? strictOptions : fallbackOptions
  const usingFallback = strictOptions.length === 0 && fallbackOptions.length > 0

  return (
    <CardSection title="SMART MATCH">
      <div className="flex items-center justify-between text-xs text-ds-ink-faint mb-2.5">
        <span>
          {boardOptions.length > 0
            ? `${boardOptions.length} board ${boardOptions.length === 1 ? 'match' : 'matches'}${usingFallback ? ' · compatible' : ''}`
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
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${t.pill}`}>
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
      ) : boardOptions.length > 0 ? (
        <div className="space-y-3">
          {boardOptions.slice(0, 4).map((opt, idx) => (
            <BoardOptionCard key={opt.materialId || `${opt.materialCode}-${idx}`} opt={opt} rank={idx + 1} />
          ))}
        </div>
      ) : (
        <div className="rounded-ds-md border border-dashed border-ds-line/50 bg-ds-elevated/40 p-4 text-center text-sm text-ds-ink-faint">
          No matching board found in stock yet.
        </div>
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
}
