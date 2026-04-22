'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  applyBatchDecisionAction,
  BATCH_STATUS_BADGE_CLASS,
  BATCH_STATUS_LABEL,
  buildBatchGroups,
  effectiveBatchStatus,
  type PlanningBatchDecisionAction,
} from '@/lib/planning-batch-decision'
import { readPlanningCore, type PlanningCore } from '@/lib/planning-decision-spec'

export type PlanningBatchPanelLine = {
  id: string
  poNumber: string
  cartonName: string
  quantity: number
  specOverrides: Record<string, unknown> | null
}

type Props = {
  lines: PlanningBatchPanelLine[]
  onApply: (lineIds: string[], action: PlanningBatchDecisionAction, holdReason?: string) => Promise<void>
  busy?: boolean
}

function firstLineSpecCore(lines: PlanningBatchPanelLine[], ids: string[]): PlanningCore {
  const firstId = ids[0]
  const row = firstId ? lines.find((l) => l.id === firstId) : undefined
  return readPlanningCore(
    (row?.specOverrides && typeof row.specOverrides === 'object' ? row.specOverrides : {}) as Record<
      string,
      unknown
    >,
  )
}

export function PlanningBatchDecisionPanel({ lines, onApply, busy }: Props) {
  const groups = useMemo(() => buildBatchGroups(lines), [lines])
  const [holdOpenKey, setHoldOpenKey] = useState<string | null>(null)
  const [holdReason, setHoldReason] = useState('')

  if (groups.length === 0) return null

  return (
    <div className="rounded-lg border border-[#334155] bg-[#0f172a] px-2 py-2">
      <h2 className="text-[11px] font-bold uppercase tracking-wider text-amber-400/95">Batch decisions</h2>
      <p className="mb-2 text-[11px] text-slate-500">
        Approve a batch, place it on hold, or send a <span className="text-slate-400">ready</span> batch to artwork.
        Held batches are blocked from handoff and processing.
      </p>
      <div className="max-h-[22rem] space-y-2 overflow-auto pr-0.5">
        {groups.map((g) => {
          const core = firstLineSpecCore(lines, g.lineIds)
          const st = effectiveBatchStatus(core)
          const canApprove = applyBatchDecisionAction(core, 'approve_batch') != null
          const canHold = applyBatchDecisionAction(core, 'hold_batch') != null
          const canSend = applyBatchDecisionAction(core, 'send_to_artwork') != null
          const canRelease = applyBatchDecisionAction(core, 'release_to_production') != null
          const canResume = applyBatchDecisionAction(core, 'resume_from_hold') != null
          const onHold = st === 'hold'
          return (
            <div
              key={g.key}
              className={`rounded-md border px-2 py-1.5 ${
                onHold
                  ? 'border-rose-600/50 bg-rose-950/20'
                  : 'border-[#334155] bg-[#1E293B]/80'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex max-w-full shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-tight ${
                    BATCH_STATUS_BADGE_CLASS[st]
                  }`}
                >
                  {BATCH_STATUS_LABEL[st]}
                </span>
                <span className="min-w-0 truncate text-[12px] font-mono text-slate-300" title={g.title}>
                  {g.title}
                </span>
                <span className="text-[11px] text-slate-500">
                  {g.lineIds.length} job{g.lineIds.length === 1 ? '' : 's'} · Σ{' '}
                  <span className="font-mono text-amber-200/90">
                    {g.lineIds
                      .reduce((s, id) => s + (lines.find((l) => l.id === id)?.quantity ?? 0), 0)
                      .toLocaleString('en-IN')}
                  </span>
                </span>
              </div>
              {onHold && core.batchHoldReason ? (
                <p className="mt-1 line-clamp-2 text-[11px] text-rose-200/90" title={core.batchHoldReason}>
                  <span className="font-semibold text-rose-300/95">Reason:</span> {core.batchHoldReason}
                </p>
              ) : null}
              <ul className="mt-1 max-h-16 overflow-y-auto text-[10px] text-slate-500">
                {g.lineIds.map((id) => {
                  const li = lines.find((l) => l.id === id)
                  if (!li) return null
                  return (
                    <li key={id} className="truncate">
                      {li.poNumber} · {li.cartonName} · {li.quantity.toLocaleString('en-IN')}
                    </li>
                  )
                })}
              </ul>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <button
                  type="button"
                  disabled={busy || !canApprove}
                  title={!canApprove ? 'Only available from Draft' : 'Mark batch ready (approved for next step)'}
                  className="rounded bg-sky-800/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void onApply(g.lineIds, 'approve_batch')}
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy || !canHold}
                  className="rounded bg-amber-800/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => {
                    setHoldReason('')
                    setHoldOpenKey((k) => (k === g.key ? null : g.key))
                  }}
                >
                  Hold
                </button>
                {holdOpenKey === g.key ? (
                  <span className="inline-flex w-full min-w-0 flex-wrap items-center gap-1 py-0.5">
                    <input
                      className="min-w-0 flex-1 rounded border border-amber-700/50 bg-slate-950 px-1.5 py-0.5 text-[11px] text-slate-100"
                      placeholder="Reason required"
                      value={holdReason}
                      onChange={(e) => setHoldReason(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      className="shrink-0 rounded bg-rose-800 px-2 py-0.5 text-[11px] text-white"
                      onClick={async () => {
                        if (!holdReason.trim()) {
                          toast.error('Enter a hold reason')
                          return
                        }
                        const test = applyBatchDecisionAction(
                          firstLineSpecCore(lines, g.lineIds),
                          'hold_batch',
                          { holdReason: holdReason.trim() },
                        )
                        if (!test) {
                          toast.error('Cannot hold this batch now')
                          return
                        }
                        setHoldOpenKey(null)
                        await onApply(g.lineIds, 'hold_batch', holdReason.trim())
                      }}
                    >
                    Confirm
                    </button>
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={busy || !canSend}
                  title={!canSend ? 'Only ready batches can go to artwork' : 'Mark approved for artwork'}
                  className="rounded bg-violet-800/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void onApply(g.lineIds, 'send_to_artwork')}
                >
                  To Artwork
                </button>
                <button
                  type="button"
                  disabled={busy || !canRelease}
                  className="rounded bg-emerald-800/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void onApply(g.lineIds, 'release_to_production')}
                >
                  To Production
                </button>
                <button
                  type="button"
                  disabled={busy || !canResume}
                  className="rounded border border-slate-600 bg-slate-800/90 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void onApply(g.lineIds, 'resume_from_hold')}
                >
                  Resume
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
