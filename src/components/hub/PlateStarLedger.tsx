'use client'

import { hubChannelRowsFromLabels } from '@/lib/hub-plate-card-ui'
import { PlateHubColourSwatch } from '@/components/hub/PlateHubColourSwatch'

const STAR_CAP = 5

/** Per-channel usage stars for hub cards (high-density). */
export function PlateStarLedger({
  labels,
  cycleData,
  className = '',
}: {
  labels: string[]
  cycleData: Record<string, number> | null | undefined
  className?: string
}) {
  const map = cycleData ?? {}
  const rows = hubChannelRowsFromLabels(labels)
  if (!rows.length) return null

  return (
    <div
      className={`text-xs font-mono leading-tight text-neutral-500 space-y-0.5 ${className}`}
      aria-label="Usage cycles by colour"
    >
      {rows.map((r, idx) => {
        const n = Math.max(0, Math.floor(map[r.short] ?? 0))
        const shown = Math.min(STAR_CAP, n)
        const plus = n > STAR_CAP ? n - STAR_CAP : 0
        return (
          <div key={`${r.key}-${idx}`} className="flex flex-wrap items-center gap-x-0.5 gap-y-0">
            <PlateHubColourSwatch short={r.short} label={r.label} size="sm" className="mr-0.5" />
            {Array.from({ length: shown }, (_, i) => (
              <span key={i} className="text-yellow-500 text-xs leading-none" aria-hidden>
                ★
              </span>
            ))}
            {plus > 0 ? (
              <span className="text-yellow-500 shrink-0" aria-hidden>
                +{plus}
              </span>
            ) : null}
            <span className="text-neutral-500 shrink-0">({n})</span>
          </div>
        )
      })}
    </div>
  )
}
