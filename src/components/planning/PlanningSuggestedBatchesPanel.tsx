'use client'

import { useMemo } from 'react'
import { Check, Pencil, Sparkles, X } from 'lucide-react'
import {
  type SuggestableLine,
  type SuggestedBatch,
  suggestBatches,
} from '@/lib/planning-batch-suggestions'

const mono = 'font-designing-queue tabular-nums tracking-tight'

const labelClass: Record<SuggestedBatch['label'], string> = {
  High: 'text-emerald-300 ring-emerald-500/50 bg-emerald-500/15',
  Medium: 'text-ds-warning ring-ds-warning/35 bg-ds-warning/8',
  Low: 'text-rose-200 ring-rose-500/40 bg-rose-500/10',
}

type Props = {
  lines: SuggestableLine[]
  dismissedIds: Set<string>
  onDismiss: (id: string) => void
  onAccept: (lineIds: string[]) => void
  onModify: (lineIds: string[]) => void
}

export function PlanningSuggestedBatchesPanel({ lines, dismissedIds, onAccept, onModify, onDismiss }: Props) {
  const suggestions = useMemo(() => {
    const raw = suggestBatches(lines)
    return raw.filter((s) => !dismissedIds.has(s.id))
  }, [lines, dismissedIds])

  if (suggestions.length === 0) {
    return (
      <div className="rounded-lg border border-ds-line/55 bg-ds-card/30 px-3 py-2 text-center text-[12px] text-ds-ink-faint">
        No batch suggestions for the current view.
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-ds-ink-muted">
        <Sparkles className="h-4 w-4 text-cyan-400" aria-hidden />
        <h2 className="text-[12px] font-semibold tracking-tight text-cyan-400/95">Suggested batches</h2>
        <span className={`text-[11px] text-ds-ink-faint ${mono}`}>{suggestions.length}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((b) => (
          <article
            key={b.id}
            className="flex w-full min-w-[16rem] max-w-sm flex-1 flex-col rounded-xl border border-cyan-500/20 bg-gradient-to-b from-cyan-950/25 to-ds-card/50 p-3 shadow-sm sm:min-w-[18rem]"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className={`text-[11px] text-ds-ink-faint ${mono}`}>
                  {b.lineIds.length} jobs · Qty {b.totalQty.toLocaleString('en-IN')} · ~sheets {b.estimatedSheets.toLocaleString('en-IN')}
                </p>
                <p className="mt-1 text-[20px] font-bold tabular-nums leading-none text-ds-warning">{b.score}</p>
                <p className="text-[10px] font-medium text-ds-ink-faint">efficiency score</p>
                <div className="mt-1.5">
                  <span
                    className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-bold ring-1 ${labelClass[b.label]}`}
                  >
                    {b.label}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onDismiss(b.id)}
                className="shrink-0 rounded p-1 text-ds-ink-faint hover:bg-ds-elevated hover:text-ds-ink-muted"
                title="Dismiss"
                aria-label="Dismiss suggestion"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="mt-3 max-h-28 space-y-1 overflow-y-auto border-t border-ds-line/50 pt-2 text-[11px] text-ds-ink-muted">
              {b.lineSummaries.map((l) => (
                <li key={l.id} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate" title={l.cartonLabel}>
                    <span className="font-mono text-ds-warning/80">{l.poNumber}</span> — {l.cartonLabel}
                  </span>
                  <span className={`shrink-0 text-ds-ink-faint ${mono}`}>
                    {l.qty} · {l.yieldPct}%
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[9px] text-ds-ink-faint">
              Yield {b.meanYieldPct}% · est. waste ~{b.estWastagePct}%
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onAccept(b.lineIds)}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-emerald-700/90 px-3 py-2 text-[12px] font-semibold text-white hover:bg-emerald-600"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
                Accept
              </button>
              <button
                type="button"
                onClick={() => onModify(b.lineIds)}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-ds-line/50 bg-ds-elevated/60 px-3 py-2 text-[12px] font-medium text-ds-ink hover:bg-ds-elevated"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                Modify
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
