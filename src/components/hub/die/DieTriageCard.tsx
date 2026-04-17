'use client'

import { hubQueueAgeLabel } from '@/lib/hub-card-time'
import type { SimilarDieMatch } from '@/components/hub/die/SimilarDiesModal'

/** Die row fields needed for incoming triage (Die Hub). */
export type DieTriageCardRow = {
  id: string
  displayCode: string
  title: string
  ledgerRank: number
  dimensionsLwh: string
  dimensionsLabel: string
  lastStatusUpdatedAt: string
  similarMatches: SimilarDieMatch[]
  typeMismatchMatches?: SimilarDieMatch[]
  masterType?: string | null
}

export function DieTriageCard({
  r,
  saving,
  onOpenAudit,
  onRouteToVendor,
  onTakeFromStock,
  onSimilarClick,
  specs,
}: {
  r: DieTriageCardRow
  saving: boolean
  onOpenAudit: () => void
  onRouteToVendor: () => void
  onTakeFromStock: () => void
  onSimilarClick: () => void
  specs: React.ReactNode
}) {
  const mismatch = r.typeMismatchMatches ?? []
  const hasTypeMismatch = mismatch.length > 0
  const hasSimilar = !hasTypeMismatch && r.similarMatches.length > 0
  const dimTitle = r.dimensionsLwh || r.dimensionsLabel

  return (
    <li className="rounded-lg border border-zinc-800 bg-black p-2 overflow-visible">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 border border-zinc-700 text-[10px] font-mono font-bold text-zinc-500"
            title="Row #"
          >
            #{r.ledgerRank}
          </span>
          <span className="font-mono text-[10px] text-amber-300/90 truncate">{r.displayCode}</span>
        </div>
        {hasTypeMismatch ? (
          <button
            type="button"
            onClick={onSimilarClick}
            className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-red-400 border border-red-600/60 rounded px-1.5 py-0.5 hover:bg-red-950/40"
          >
            Type mismatch
          </button>
        ) : hasSimilar ? (
          <button
            type="button"
            onClick={onSimilarClick}
            className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-amber-500 border border-amber-600/60 rounded px-1.5 py-0.5 hover:bg-amber-950/50"
          >
            Similar
          </button>
        ) : null}
      </div>
      <p className="text-[11px] text-zinc-500 truncate mt-1" title={r.title}>
        {r.title}
      </p>
      <button
        type="button"
        className="text-left w-full text-blue-400 hover:text-blue-300 hover:underline font-semibold text-sm mt-0.5 truncate"
        onClick={onOpenAudit}
      >
        {dimTitle}
      </button>
      {specs}
      <div className="mt-1.5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving}
          className="flex-1 min-w-[140px] py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold disabled:opacity-50"
          onClick={onRouteToVendor}
        >
          Route to outside vendor
        </button>
        <button
          type="button"
          disabled={saving}
          className="flex-1 min-w-[140px] py-1.5 rounded-md border border-zinc-500 bg-zinc-900 hover:bg-zinc-800 text-zinc-100 text-xs font-medium disabled:opacity-50"
          onClick={onTakeFromStock}
        >
          Take from stock
        </button>
      </div>
      <p className="mt-1.5 text-[10px] leading-tight text-zinc-500">
        Time in triage: {hubQueueAgeLabel(r.lastStatusUpdatedAt)}
      </p>
    </li>
  )
}
