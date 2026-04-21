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
  const panel =
    'rounded-lg border border-[#E2E8F0] bg-white p-3 space-y-3 shadow-sm dark:border-slate-800 dark:bg-[#000000] dark:shadow-none'

  const selectCls = `h-8 min-w-[10rem] rounded border border-[#E2E8F0] bg-white px-2 text-[11px] text-[#1A1A1B] dark:border-white/15 dark:bg-black dark:text-slate-200 ${mono}`

  return (
    <div className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className={`text-[10px] font-semibold uppercase tracking-wide text-slate-500 ${mono}`}>
            Planning decision layer
          </p>
          <p className="text-[9px] text-slate-600 dark:text-slate-600 mt-0.5">
            PO intake → decisions here → immutable handoff to AW Queue on save.
          </p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={onSavePlanning}
          className={`inline-flex items-center gap-1.5 rounded-lg border border-emerald-600/40 bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-500/50 dark:bg-emerald-500/10 dark:text-emerald-200 dark:hover:bg-emerald-500/20 ${mono}`}
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
          {saving ? 'Saving…' : 'Save planning'}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-0.5">
          <span className={`text-[9px] uppercase text-slate-500 ${mono}`}>Spec sort / group</span>
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

        <div className="flex rounded border border-[#E2E8F0] overflow-hidden dark:border-white/10">
          <button
            type="button"
            onClick={() => onSetIdModeChange('auto')}
            className={`px-2.5 py-1.5 text-[10px] font-medium ${mono} ${
              setIdMode === 'auto'
                ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200'
                : 'bg-white text-slate-600 hover:text-slate-900 dark:bg-black dark:text-slate-500 dark:hover:text-slate-300'
            }`}
          >
            Set ID · Auto
          </button>
          <button
            type="button"
            onClick={() => onSetIdModeChange('manual')}
            className={`px-2.5 py-1.5 text-[10px] font-medium border-l border-[#E2E8F0] dark:border-white/10 ${mono} ${
              setIdMode === 'manual'
                ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200'
                : 'bg-white text-slate-600 hover:text-slate-900 dark:bg-black dark:text-slate-500 dark:hover:text-slate-300'
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
            className={`inline-flex items-center gap-1 rounded border border-sky-500/50 bg-sky-50 px-2.5 py-1.5 text-[10px] font-medium text-sky-900 hover:bg-sky-100 disabled:opacity-35 disabled:cursor-not-allowed dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200 dark:hover:bg-sky-500/20 ${mono}`}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            Link as mix-set ({selectionCount})
          </button>
        </div>
      </div>
    </div>
  )
}
