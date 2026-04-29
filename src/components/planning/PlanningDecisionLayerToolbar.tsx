'use client'

import { Link2, Save } from 'lucide-react'
import type { PlanningSetIdMode } from '@/lib/planning-decision-spec'

const mono = 'font-designing-queue tabular-nums tracking-tight'

/** `board` = multi-column sort: Paper → GSM → Coating → Carton size (gang-print grouping). */
export type PlanningGroupBy = 'none' | 'cartonSize' | 'gsm' | 'coating' | 'board'

export function PlanningDecisionLayerToolbar({
  selectionCount,
  onLinkAsMixSet,
  onSavePlanning,
  groupBy,
  onGroupByChange,
  setIdMode,
  onSetIdModeChange,
  saving,
}: {
  selectionCount: number
  onLinkAsMixSet: () => void
  onSavePlanning: () => void
  groupBy: PlanningGroupBy
  onGroupByChange: (g: PlanningGroupBy) => void
  setIdMode: PlanningSetIdMode
  onSetIdModeChange: (m: PlanningSetIdMode) => void
  saving?: boolean
}) {
  const panel = 'rounded-lg border border-ds-line/70 bg-ds-elevated/70 p-3 space-y-2.5 shadow-md ring-1 ring-ds-line/30'

  const selectCls = `h-9 w-full min-w-[12rem] max-w-[22rem] rounded border border-ds-brand/35 bg-ds-main/95 px-2 text-sm font-medium text-ds-ink shadow-sm transition focus:border-ds-brand focus:outline-none focus:ring-2 focus:ring-ds-brand/30 ${mono}`

  return (
    <div className={panel}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className={`text-xs font-semibold uppercase tracking-wider text-ds-ink ${mono}`}>
            Planning decision layer
          </p>
          <p className="mt-0.5 max-w-[52rem] break-words text-xs leading-snug text-ds-ink">
            PO intake &rarr; decisions here &rarr; immutable handoff to AW Queue on save.
          </p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={onSavePlanning}
          className={`inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-300 hover:opacity-90 disabled:opacity-40 ${mono}`}
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
          {saving ? 'Saving…' : 'Save planning'}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(16rem,auto)_auto_auto] lg:items-end">
        <label className="min-w-0 space-y-0.5">
          <span className={`text-xs font-semibold uppercase tracking-wider text-ds-ink ${mono}`}>Spec sort / group</span>
          <select
            value={groupBy}
            onChange={(e) => onGroupByChange(e.target.value as PlanningGroupBy)}
            className={selectCls}
          >
            <option value="none">None (PO order)</option>
            <option value="board">Board spec (Paper → GSM → Coating → Carton)</option>
            <option value="cartonSize">Carton size</option>
            <option value="gsm">GSM</option>
            <option value="coating">Coating type</option>
          </select>
        </label>

        <div className="flex rounded-md border border-ds-line/50 overflow-hidden">
          <button
            type="button"
            onClick={() => onSetIdModeChange('auto')}
            className={`px-2.5 py-1.5 text-xs font-medium ${mono} ${
              setIdMode === 'auto'
                ? 'bg-ds-warning/8 text-ds-warning'
                : 'bg-ds-main text-ds-ink-muted hover:bg-ds-elevated'
            }`}
          >
            Set ID · Auto
          </button>
          <button
            type="button"
            onClick={() => onSetIdModeChange('manual')}
            className={`px-2.5 py-1.5 text-xs font-medium border-l border-ds-line/50 ${mono} ${
              setIdMode === 'manual'
                ? 'bg-ds-warning/8 text-ds-warning'
                : 'bg-ds-main text-ds-ink-muted hover:bg-ds-elevated'
            }`}
          >
            Set ID · Manual
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={selectionCount < 2}
            onClick={onLinkAsMixSet}
            title="Link selected lines as one gang / mix-set"
            className={`inline-flex items-center gap-1 rounded-md border border-ds-line/50 bg-ds-main px-2.5 py-1.5 text-xs font-medium text-blue-300 hover:bg-ds-elevated disabled:opacity-35 disabled:cursor-not-allowed ${mono}`}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            Link as mix-set ({selectionCount})
          </button>
        </div>
      </div>
    </div>
  )
}
