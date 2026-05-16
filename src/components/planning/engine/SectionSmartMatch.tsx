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

function OptionCard({
  opt,
  rank,
  best,
  onUse,
  busy,
}: {
  opt: PlanningEngineBoardOption
  rank: number
  best: boolean
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
            {opt.boardType ?? '—'}
            {opt.boardClassification ? ` · ${opt.boardClassification}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge tone={statusTone(opt.status)} className="text-[9px]">{opt.status}</Badge>
          <span className={`text-xs font-semibold tabular-nums ${fitTone(fit)}`}>Fit {fit}</span>
        </div>
      </div>

      {/* Size + requirement mapping (previous logic) */}
      <div className="grid grid-cols-3 gap-2 text-[11px] mb-2">
        <div>
          <div className="text-ds-ink-faint">Size</div>
          <div className="text-ds-ink tabular-nums">
            {opt.size}
            <span className="text-ds-ink-faint"> · {opt.orientation}</span>
          </div>
        </div>
        <div>
          <div className="text-ds-ink-faint">GSM</div>
          <div className="text-ds-ink tabular-nums">
            {opt.gsm ?? '—'}
            {opt.gsmDelta != null && opt.gsmDelta !== 0 ? (
              <span className="text-amber-300"> ({opt.gsmDelta > 0 ? '+' : ''}{opt.gsmDelta})</span>
            ) : null}
          </div>
        </div>
        <div>
          <div className="text-ds-ink-faint">Match</div>
          <div className="text-ds-ink truncate">{opt.matchType}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px] mb-2">
        <div>
          <div className="text-ds-ink-faint">Required</div>
          <div className="text-ds-ink tabular-nums">{nf.format(opt.requiredParentSheets)} sh</div>
        </div>
        <div>
          <div className="text-ds-ink-faint">Wastage</div>
          <div className="text-ds-ink tabular-nums">{opt.wastagePct.toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-ds-ink-faint">Yield</div>
          <div className="text-ds-ink tabular-nums">{opt.yieldPct.toFixed(1)}%</div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-ds-line/30">
        <div className="text-[11px] text-ds-ink-faint tabular-nums">
          Avail <span className="text-ds-ink">{nf.format(opt.availableSheets)}</span>
          {' · '}Rsvd <span className="text-ds-ink">{nf.format(opt.reservedSheets)}</span>
          {' · '}Free <span className="text-ds-ink">{nf.format(opt.freeSheets)}</span>
          {opt.shortageParentSheets > 0 ? (
            <span className="text-red-300"> · Short {nf.format(opt.shortageParentSheets)}</span>
          ) : null}
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

  const handleUse = async (opt: PlanningEngineBoardOption) => {
    setBusyId(opt.materialId)
    try {
      // Persist the chosen board on the line spec; atomic reservation lands in Phase 4.
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
      <div className="flex items-center justify-between text-[10px] text-ds-ink-faint mb-2">
        <span>
          {readiness
            ? [readiness.boardType, readiness.gsm ? `${readiness.gsm}g` : null, readiness.size]
                .filter(Boolean)
                .join(' · ')
            : '—'}
        </span>
        {primary.length > 0 ? (
          <span className="rounded-ds-sm border border-ds-line/50 bg-ds-elevated px-1.5 py-0.5">
            {strict.length > 0 ? `${strict.length} strict` : `${closest.length} compatible`}
          </span>
        ) : null}
      </div>

      {primary.length === 0 ? (
        <div className="rounded-ds-md border border-dashed border-ds-line/50 bg-ds-elevated/40 p-4 text-center text-xs text-ds-ink-faint">
          No board options matched on size / GSM yet. Check the requirement or raise a PR.
        </div>
      ) : (
        <div className="space-y-2">
          {primary.slice(0, 5).map((opt, idx) => (
            <OptionCard
              key={opt.materialId}
              opt={opt}
              rank={opt.matchRank ?? idx + 1}
              best={idx === 0 && strict.length > 0}
              busy={busyId === opt.materialId}
              onUse={() => { void handleUse(opt) }}
            />
          ))}
        </div>
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
                  busy={busyId === opt.materialId}
                  onUse={() => { void handleUse(opt) }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </CardSection>
  )
}
