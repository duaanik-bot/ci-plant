'use client'

import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

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
      <div className="flex items-center justify-between text-[10px] text-ds-ink-faint mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(value)}</span>
      </div>
      <div className="h-1 rounded-full bg-ds-elevated overflow-hidden">
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

export function SectionSmartMatch({ line, readiness, onPatch: _onPatch }: Props) {
  const suggestions = line.smartMatch?.suggestions ?? []
  const matchedOn = line.smartMatch?.matchedOn ?? null
  const materialCode = line.smartMatch?.materialCode ?? readiness?.materialCode ?? null
  const confidence = line.smartMatch?.boardMatchConfidence ?? null

  return (
    <CardSection title="SMART MATCH">
      <div className="flex items-center justify-end text-[10px] text-ds-ink-faint mb-2">
        {[readiness?.boardType, readiness?.gsm ? `${readiness.gsm}g` : null]
          .filter(Boolean)
          .join(' · ') || '—'}
      </div>

      {suggestions.length === 0 ? (
        <div className="rounded-ds-md border border-dashed border-ds-line/50 bg-ds-elevated/40 p-4 text-center text-xs text-ds-ink-faint">
          No suggestions yet — scoring engine ships in Phase 3.
        </div>
      ) : (
        <div className="space-y-2.5">
          {suggestions.slice(0, 3).map((s, idx) => {
            const t = tierClass(s.tier)
            return (
              <div key={`${s.label}-${idx}`} className={`rounded-ds-md border p-3 ${t.ring}`}>
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-ds-ink">Suggestion {s.label}</div>
                    <div className="text-[11px] text-ds-ink-faint truncate">
                      {s.poRefs.join(' · ')} + this line
                    </div>
                  </div>
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${t.pill}`}>
                    {s.tier} · <span className="tabular-nums">{s.composite.toFixed(1)}</span>
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-ds-ink-faint mb-2 tabular-nums">
                  <span>{s.linesIncluded} lines</span>
                  <span>·</span>
                  <span>{nf.format(s.totalPcs)} pcs</span>
                  <span>·</span>
                  <span>Avg yield {s.avgYieldPct.toFixed(1)}%</span>
                  <span>·</span>
                  <span>~{nf.format(s.totalSheets)} sh</span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <SubScoreBar label="Size" value={s.sizeScore} />
                  <SubScoreBar label="Waste" value={s.wasteScore} />
                  <SubScoreBar label="Urgency" value={s.urgencyScore} />
                  <SubScoreBar label="Tool" value={s.toolScore} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {confidence != null ? (
        <div className="mt-3 rounded-ds-md border border-ds-line/40 bg-ds-elevated/40 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              Board match confidence
            </div>
            <span className="text-emerald-300 text-xs font-semibold tabular-nums">
              {Math.round(confidence * 100)}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-ds-elevated overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-400/80"
              style={{ width: `${Math.max(0, Math.min(100, confidence * 100))}%` }}
            />
          </div>
          {matchedOn || materialCode ? (
            <div className="mt-2 text-[11px] text-ds-ink-faint">
              {matchedOn ? `Matched on ${matchedOn}` : 'Match basis pending'}
              {materialCode ? ` — material code ${materialCode}` : ''}
            </div>
          ) : null}
        </div>
      ) : null}
    </CardSection>
  )
}
