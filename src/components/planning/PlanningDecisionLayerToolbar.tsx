'use client'

import { Link2, Save } from 'lucide-react'
import type { PlanningSetIdMode } from '@/lib/planning-decision-spec'

const mono = 'font-designing-queue tabular-nums tracking-tight'

export type PlanningGroupBy = 'none' | 'cartonSize' | 'gsm' | 'coating'

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
  return (
    <div className="rounded-lg border border-slate-800 bg-[#000000] p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className={`text-[10px] font-semibold uppercase tracking-wide text-slate-500 ${mono}`}>
            Planning decision layer
          </p>
          <p className="text-[9px] text-slate-600 mt-0.5">
            PO intake → decisions here → immutable handoff to AW Queue on save.
          </p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={onSavePlanning}
          className={`inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40 ${mono}`}
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
            className={`h-8 min-w-[10rem] rounded border border-white/15 bg-black px-2 text-[11px] text-slate-200 ${mono}`}
          >
            <option value="none">None (PO order)</option>
            <option value="cartonSize">Carton size</option>
            <option value="gsm">GSM</option>
            <option value="coating">Coating type</option>
          </select>
        </label>

        <div className="flex rounded border border-white/10 overflow-hidden">
          <button
            type="button"
            onClick={() => onSetIdModeChange('auto')}
            className={`px-2.5 py-1.5 text-[10px] font-medium ${mono} ${
              setIdMode === 'auto'
                ? 'bg-amber-500/15 text-amber-200'
                : 'bg-black text-slate-500 hover:text-slate-300'
            }`}
          >
            Set ID · Auto
          </button>
          <button
            type="button"
            onClick={() => onSetIdModeChange('manual')}
            className={`px-2.5 py-1.5 text-[10px] font-medium border-l border-white/10 ${mono} ${
              setIdMode === 'manual'
                ? 'bg-amber-500/15 text-amber-200'
                : 'bg-black text-slate-500 hover:text-slate-300'
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
            className={`inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-[10px] font-medium text-sky-200 hover:bg-sky-500/20 disabled:opacity-35 disabled:cursor-not-allowed ${mono}`}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            Link as mix-set ({selectionCount})
          </button>
        </div>
      </div>
    </div>
  )
}
