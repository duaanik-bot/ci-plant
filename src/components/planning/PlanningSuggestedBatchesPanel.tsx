'use client'

import { useMemo, useState } from 'react'
import { Check, Pencil, X, Sparkles } from 'lucide-react'
import {
  type SuggestableLine,
  type SuggestedBatch,
  suggestBatches,
} from '@/lib/planning-batch-suggestions'

const mono = 'font-designing-queue tabular-nums tracking-tight'

const labelClass: Record<SuggestedBatch['label'], string> = {
  High: 'text-emerald-300 ring-emerald-500/40 bg-emerald-500/10',
  Medium: 'text-amber-200 ring-amber-500/35 bg-amber-500/10',
  Low: 'text-rose-200 ring-rose-500/30 bg-rose-500/10',
}

type Props = {
  lines: SuggestableLine[]
  /** dismissed suggestion ids (persist in parent) */
  dismissedIds: Set<string>
  onDismiss: (id: string) => void
  onAccept: (lineIds: string[]) => void
  onModify: (lineIds: string[]) => void
}

export function PlanningSuggestedBatchesPanel({ lines, dismissedIds, onDismiss, onAccept, onModify }: Props) {
  const [expandId, setExpandId] = useState<string | null>(null)
  const suggestions = useMemo(() => {
    const raw = suggestBatches(lines)
    return raw.filter((s) => !dismissedIds.has(s.id))
  }, [lines, dismissedIds])

  if (suggestions.length === 0) {
    return (
      <div className="rounded-lg border border-slate-600/50 bg-slate-900/20 px-3 py-2 text-[12px] text-slate-500">
        <span className="font-semibold text-slate-400">Suggested batches</span> — no compatible multi-job groups
        right now. Add rows with the same board, GSM, and coating, or check hold / closed lines.
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-cyan-500/25 bg-cyan-950/10 px-2 py-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-cyan-400" aria-hidden />
        <h2 className="text-xs font-bold uppercase tracking-wider text-cyan-400">Suggested batches</h2>
        <span className={`text-[11px] text-slate-500 ${mono}`}>({suggestions.length})</span>
      </div>
      <p className="mb-2 text-[10px] leading-snug text-slate-500">
        Grouped by board, GSM, coating, and print bucket; sorted by size; packed until sheet/efficiency limits.
        Scores: size 40% · waste 30% · urgency 20% · tooling 10%.
      </p>
      <ul className="max-h-72 space-y-2 overflow-y-auto pr-0.5">
        {suggestions.map((b) => {
          const open = expandId === b.id
          return (
            <li
              key={b.id}
              className="rounded-md border border-slate-600/50 bg-[#0f1729] p-2 text-[12px] text-slate-200"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-mono text-slate-500" title={b.groupKey}>
                    {b.lineIds.length} jobs · Sum qty{' '}
                    <span className="text-amber-200/95">{b.totalQty.toLocaleString('en-IN')}</span>
                    {' · '}
                    ~sheets {b.estimatedSheets.toLocaleString('en-IN')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ring-1 ${labelClass[b.label]}`}
                  >
                    {b.label} · {b.score}
                  </span>
                  <button
                    type="button"
                    className="text-[10px] text-sky-400/90 underline-offset-1 hover:underline"
                    onClick={() => setExpandId(open ? null : b.id)}
                  >
                    {open ? 'Hide' : 'Details'}
                  </button>
                </div>
              </div>
              {open ? (
                <div className="mt-2 space-y-1 border-t border-slate-700/60 pt-2 text-[11px] text-slate-400">
                  <p>
                    Avg yield {b.meanYieldPct}% · Est. waste ~{b.estWastagePct}% · sub: SF {b.subscores.sizeFit} / W{' '}
                    {b.subscores.waste} / U {b.subscores.urgency} / T {b.subscores.tooling}
                  </p>
                  <ul className="list-inside list-disc text-slate-300">
                    {b.lineSummaries.map((l) => (
                      <li key={l.id}>
                        <span className="font-mono text-amber-200/80">{l.poNumber}</span> — {l.cartonLabel.slice(0, 48)}
                        {l.cartonLabel.length > 48 ? '…' : ''} · {l.qty} · {l.yieldPct}%
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => onAccept(b.lineIds)}
                  className="inline-flex items-center gap-0.5 rounded bg-emerald-800/80 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700/90"
                >
                  <Check className="h-3 w-3" aria-hidden />
                  Accept (link mix-set)
                </button>
                <button
                  type="button"
                  onClick={() => onModify(b.lineIds)}
                  className="inline-flex items-center gap-0.5 rounded border border-slate-500/60 bg-slate-800/50 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-800"
                >
                  <Pencil className="h-3 w-3" aria-hidden />
                  Select for edit
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(b.id)}
                  className="inline-flex items-center gap-0.5 rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800/60"
                >
                  <X className="h-3 w-3" aria-hidden />
                  Reject
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
