'use client'

export type SimilarDieMatch = {
  id: string
  displayCode: string
  location: string | null
  impressionCount: number
  reuseCount: number
  /** Other die’s master type — required context for type-mismatch alerts. */
  dieTypeLabel?: string
}

export function SimilarDiesModal({
  open,
  onClose,
  sourceLabel,
  sourceDieType,
  variant = 'similar',
  matches,
}: {
  open: boolean
  onClose: () => void
  sourceLabel: string
  /** This die’s master type (shown when `variant` is type_mismatch). */
  sourceDieType?: string
  variant?: 'similar' | 'type_mismatch'
  matches: SimilarDieMatch[]
}) {
  if (!open) return null

  const isMismatch = variant === 'type_mismatch'
  const title = isMismatch ? 'Type mismatch (same L×W×H)' : 'Similar dies (same L×W×H + master type)'
  const emptyCopy = isMismatch
    ? 'No other dies with the same dimensions but a different master type.'
    : 'No other dies with identical dimensions and die type.'

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="similar-dies-title"
    >
      <div
        className="ci-hub-modal-panel max-w-lg max-h-[85vh] flex flex-col !p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3.5 py-3 border-b border-zinc-800 shrink-0">
          <h2
            id="similar-dies-title"
            className={`ci-hub-modal-title border-0 pb-0 ${isMismatch ? '!text-red-400' : ''}`}
          >
            {title}
          </h2>
          <p className="text-[11px] text-zinc-500 mt-2 leading-snug">
            {isMismatch ? (
              <>
                Same footprint as <span className="text-amber-300 font-mono">{sourceLabel}</span>
                {sourceDieType ? (
                  <>
                    {' '}
                    (<span className="text-zinc-300">{sourceDieType}</span>)
                  </>
                ) : null}
                — verify master type before taking from rack.
              </>
            ) : (
              <>
                Matches for <span className="text-amber-300 font-mono">{sourceLabel}</span> — rack / star
                ledger usage
              </>
            )}
          </p>
        </div>
        <div className="overflow-y-auto p-3 space-y-2">
          {matches.length === 0 ? (
            <p className="text-sm text-zinc-500">{emptyCopy}</p>
          ) : (
            matches.map((m) => (
              <div
                key={m.id}
                className={`rounded-lg border px-3 py-2 text-xs ${
                  isMismatch ? 'border-red-900/80 bg-red-950/20' : 'border-zinc-800 bg-black'
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-amber-200/90 font-semibold">{m.displayCode}</span>
                  <span className="text-[10px] text-zinc-500">
                    Imp: <span className="text-zinc-300 tabular-nums">{m.impressionCount}</span>
                    <span className="mx-1 text-zinc-700">·</span>
                    Cycles: <span className="text-zinc-300 tabular-nums">{m.reuseCount}</span>
                  </span>
                </div>
                {isMismatch && m.dieTypeLabel ? (
                  <p className="text-[11px] text-red-300/90 mt-1 font-medium">
                    Master type: <span className="text-red-200">{m.dieTypeLabel}</span>
                  </p>
                ) : null}
                <p className="text-[11px] text-zinc-400 mt-1">
                  Rack / slot:{' '}
                  <span className="text-zinc-200">{m.location?.trim() || '—'}</span>
                </p>
              </div>
            ))
          )}
        </div>
        <div className="px-4 py-2 border-t border-zinc-800 shrink-0 flex justify-end">
          <button
            type="button"
            className="px-3 py-1.5 rounded-md border border-zinc-600 text-zinc-300 text-xs font-semibold hover:bg-zinc-900"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
