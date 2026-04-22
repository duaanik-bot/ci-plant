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
  const panel = 'rounded-lg border border-slate-700 bg-slate-900/70 p-4 space-y-3 shadow-sm'

  const selectCls = `h-8 min-w-[10rem] rounded border border-slate-700 bg-slate-950 px-2 text-[13px] text-slate-100 ${mono}`

  return (
    <div className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className={`text-[12px] font-medium uppercase tracking-wider text-slate-500 ${mono}`}>
            Planning decision layer
          </p>
          <p className="text-[13px] text-slate-400 mt-0.5 leading-normal">
            PO intake → decisions here → immutable handoff to AW Queue on save.
          </p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={onSavePlanning}
          className={`inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-[13px] font-semibold text-emerald-300 hover:opacity-90 disabled:opacity-40 ${mono}`}
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
          {saving ? 'Saving…' : 'Save planning'}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-0.5">
          <span className={`text-[12px] font-medium uppercase tracking-wider text-slate-500 ${mono}`}>Spec sort / group</span>
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

        <div className="flex rounded-md border border-slate-700 overflow-hidden">
          <button
            type="button"
            onClick={() => onSetIdModeChange('auto')}
            className={`px-2.5 py-1.5 text-[12px] font-medium ${mono} ${
              setIdMode === 'auto'
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-slate-950 text-slate-400 hover:bg-slate-800'
            }`}
          >
            Set ID · Auto
          </button>
          <button
            type="button"
            onClick={() => onSetIdModeChange('manual')}
            className={`px-2.5 py-1.5 text-[12px] font-medium border-l border-slate-700 ${mono} ${
              setIdMode === 'manual'
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-slate-950 text-slate-400 hover:bg-slate-800'
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
            className={`inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-[12px] font-medium text-blue-300 hover:bg-slate-800 disabled:opacity-35 disabled:cursor-not-allowed ${mono}`}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            Link as mix-set ({selectionCount})
          </button>
        </div>
      </div>
    </div>
  )
}
