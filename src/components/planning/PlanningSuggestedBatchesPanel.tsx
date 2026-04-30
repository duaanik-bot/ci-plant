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
  High: 'text-[var(--success)] ring-[var(--success)]/40 bg-[var(--success-bg)]',
  Medium: 'text-[var(--warning)] ring-[var(--warning)]/35 bg-[var(--warning-bg)]',
  Low: 'text-[var(--error)] ring-[var(--error)]/35 bg-[var(--error-bg)]',
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
      <div className="rounded-lg border border-ds-line/55 bg-ds-card/30 px-3 py-2 text-center text-xs text-ds-ink-faint">
        No group suggestions for the current view.
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-ds-ink-muted">
        <Sparkles className="h-4 w-4 text-[var(--brand-primary)]" aria-hidden />
        <h2 className="text-xs font-semibold tracking-tight text-[var(--brand-primary)]">
          Suggested groups
        </h2>
        <span className={`text-xs text-ds-ink-faint ${mono}`}>{suggestions.length}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((b) => (
          <article
            key={b.id}
            className="flex w-full min-w-[16rem] max-w-sm flex-1 flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-sm sm:min-w-[18rem]"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className={`text-xs text-ds-ink-faint ${mono}`}>
                  {b.lineIds.length} jobs · Qty {b.totalQty.toLocaleString('en-IN')} · ~sheets {b.estimatedSheets.toLocaleString('en-IN')}
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums leading-none text-ds-warning">{b.score}</p>
                <p className="text-xs font-medium text-ds-ink-faint">efficiency score</p>
                <div className="mt-1.5">
                  <span
                    className={`inline-block rounded-md px-2 py-0.5 text-xs font-bold ring-1 ${labelClass[b.label]}`}
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
            <ul className="mt-3 max-h-28 space-y-1 overflow-y-auto border-t border-ds-line/50 pt-2 text-xs text-ds-ink-muted">
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
            <p className="mt-1 text-xs text-ds-ink-faint">
              Yield {b.meanYieldPct}% · est. waste ~{b.estWastagePct}%
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onAccept(b.lineIds)}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-emerald-700/90 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
                Accept
              </button>
              <button
                type="button"
                onClick={() => onModify(b.lineIds)}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-ds-line/50 bg-ds-elevated/60 px-3 py-2 text-xs font-medium text-ds-ink hover:bg-ds-elevated"
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
