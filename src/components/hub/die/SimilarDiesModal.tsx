'use client'

export type SimilarDieMatch = {
  id: string
  displayCode: string
  location: string | null
  impressionCount: number
  reuseCount: number
}

export function SimilarDiesModal({
  open,
  onClose,
  sourceLabel,
  matches,
}: {
  open: boolean
  onClose: () => void
  sourceLabel: string
  matches: SimilarDieMatch[]
}) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="similar-dies-title"
    >
      <div
        className="w-full max-w-lg rounded-xl border border-zinc-600 bg-zinc-950 shadow-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 shrink-0">
          <h2 id="similar-dies-title" className="text-sm font-bold text-white">
            Similar dies (same L×W×H)
          </h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Matches for <span className="text-amber-300 font-mono">{sourceLabel}</span> — rack / star
            ledger usage
          </p>
        </div>
        <div className="overflow-y-auto p-3 space-y-2">
          {matches.length === 0 ? (
            <p className="text-sm text-zinc-500">No other dies with identical dimensions.</p>
          ) : (
            matches.map((m) => (
              <div
                key={m.id}
                className="rounded-lg border border-zinc-800 bg-black px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-amber-200/90 font-semibold">{m.displayCode}</span>
                  <span className="text-[10px] text-zinc-500">
                    Imp: <span className="text-zinc-300 tabular-nums">{m.impressionCount}</span>
                    <span className="mx-1 text-zinc-700">·</span>
                    Cycles: <span className="text-zinc-300 tabular-nums">{m.reuseCount}</span>
                  </span>
                </div>
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
