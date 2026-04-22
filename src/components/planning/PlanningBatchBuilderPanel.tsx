'use client'

import { useMemo } from 'react'
import { Layers, Plus, X } from 'lucide-react'
import type { PlanningGridLine } from '@/components/planning/PlanningDecisionGrid'
import { readPlanningCore } from '@/lib/planning-decision-spec'
import { BATCH_STATUS_BADGE_CLASS, BATCH_STATUS_LABEL, effectiveBatchStatus } from '@/lib/planning-batch-decision'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

const mono = 'font-designing-queue tabular-nums tracking-tight'

function boardLabel(r: PlanningGridLine): string {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const bg = spec.boardGrade
  if (typeof bg === 'string' && bg.trim()) return bg.trim()
  const mq = r.materialQueue?.boardType
  if (typeof mq === 'string' && mq.trim()) return mq.trim()
  return String(r.paperType ?? r.carton?.paperType ?? '—')
}

type Props = {
  isOpen: boolean
  lines: PlanningGridLine[]
  onCreateBatch: () => void
  onRemoveFromSelection: (lineId: string) => void
  onClearSelection: () => void
  onClose: () => void
  createDisabled?: boolean
  createTitle?: string
}

export function PlanningBatchBuilderPanel({
  isOpen,
  lines,
  onCreateBatch,
  onRemoveFromSelection,
  onClearSelection,
  onClose,
  createDisabled,
  createTitle,
}: Props) {
  const { boardOk, sizeOk, ok, boards, sizes } = useMemo(() => {
    if (lines.length < 1) {
      return { boardOk: true, sizeOk: true, ok: true, boards: new Set<string>(), sizes: new Set<string>() }
    }
    const boards = new Set(lines.map((r) => boardLabel(r).toLowerCase().trim()))
    const sizes = new Set(
      lines.map((r) => String(r.cartonSize ?? '').trim().toLowerCase() || '—'),
    )
    const boardOk = boards.size <= 1
    const sizeOk = sizes.size <= 1
    const ok = boardOk && sizeOk
    return { boardOk, sizeOk, ok, boards, sizes }
  }, [lines])

  const totalQty = useMemo(
    () => lines.reduce((s, r) => s + (r.quantity || 0), 0),
    [lines],
  )

  if (!isOpen) return null
  if (lines.length < 2) return null

  return (
    <SlideOverPanel
      isOpen={isOpen}
      onClose={onClose}
      title="Batch builder"
      backdropClassName="bg-ds-main/50 backdrop-blur-[1.5px]"
      panelClassName="border-l border-ds-line/80 bg-ds-card text-ds-ink shadow-2xl"
      zIndexClass="z-[60]"
      footer={
        <div className="space-y-2">
          <button
            type="button"
            onClick={onCreateBatch}
            disabled={createDisabled || lines.length < 2}
            title={createTitle}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-ds-warning px-3 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-ds-warning disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create batch
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            className="w-full rounded-lg border border-input bg-background py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/10"
          >
            Clear selection
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-sm text-foreground" aria-label="Batch builder">
        <div className="flex items-center gap-2 text-ds-warning">
          <Layers className="h-4 w-4 shrink-0" aria-hidden />
          <p className={`text-xs text-ds-ink-faint ${mono}`}>
            {lines.length} job(s) selected · total qty {totalQty.toLocaleString('en-IN')}
          </p>
        </div>

        <div
          className={`rounded-md border border-ds-line/40 px-3 py-2 text-xs ${
            ok ? 'bg-emerald-950/25 text-emerald-200/90' : 'bg-ds-warning/8 text-ds-ink/95'
          }`}
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Compatibility</p>
          <p className="mt-0.5">
            Board: {boardOk ? 'Match' : 'Conflict'}{' '}
            <span className="text-ds-ink-faint">({Array.from(boards).join(' · ') || '—'})</span>
          </p>
          <p>
            Size: {sizeOk ? 'Match' : 'Conflict'}{' '}
            <span className="text-ds-ink-faint">({Array.from(sizes).join(' · ') || '—'})</span>
          </p>
        </div>

        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">Selected jobs</p>
          <ul className="max-h-[min(40vh,20rem)] space-y-2 overflow-y-auto overflow-x-hidden pr-0.5">
            {lines.map((r) => {
              const planCore = readPlanningCore((r.specOverrides || {}) as Record<string, unknown>)
              const b = effectiveBatchStatus(planCore)
              const hasBatch = !!(planCore.masterSetId && planCore.mixSetMemberIds && planCore.mixSetMemberIds.length > 0)
              return (
                <li
                  key={r.id}
                  className="group flex items-start justify-between gap-2 rounded-md border border-ds-line/40 bg-background px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground" title={r.cartonName}>
                      {r.cartonName}
                    </p>
                    <p className={`truncate text-[10px] text-ds-ink-faint ${mono}`}>
                      {r.po.poNumber} · {r.quantity.toLocaleString('en-IN')} · {boardLabel(r)}
                    </p>
                    {hasBatch ? (
                      <span
                        className={`mt-0.5 inline-block rounded border px-1 py-0.5 text-[8px] font-bold ${
                          BATCH_STATUS_BADGE_CLASS[b]
                        }`}
                      >
                        {BATCH_STATUS_LABEL[b]}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveFromSelection(r.id)}
                    className="shrink-0 rounded p-0.5 text-ds-ink-faint transition-colors hover:bg-accent/20 hover:text-rose-300"
                    title="Remove from selection"
                    aria-label="Remove from selection"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </SlideOverPanel>
  )
}

