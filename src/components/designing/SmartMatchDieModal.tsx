'use client'

import { X } from 'lucide-react'

export type SmartMatchDieRow = {
  id: string
  serialNumber: number
  type: string
  condition: string
  conditionBadge: string
  age: string
  location: string
  dimsMm: string
}

function badgeClass(kind: string): string {
  switch (kind) {
    case 'good':
      return 'bg-emerald-900/80 text-emerald-200 ring-1 ring-emerald-500/40'
    case 'fair':
      return 'bg-amber-900/70 text-amber-100 ring-1 ring-amber-500/35'
    case 'poor':
      return 'bg-rose-900/75 text-rose-100 ring-1 ring-rose-500/40'
    default:
      return 'bg-zinc-800 text-zinc-200 ring-1 ring-zinc-600/50'
  }
}

export function SmartMatchDieModal({
  open,
  onClose,
  targetDims,
  toleranceMm,
  rows,
  busyId,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  targetDims: string
  toleranceMm: number
  rows: SmartMatchDieRow[]
  busyId: string | null
  onSelect: (row: SmartMatchDieRow) => void
}) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 bg-background/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="smart-match-title"
    >
      <div className="w-full max-w-4xl max-h-[85vh] flex flex-col rounded-xl border border-border/15 bg-background shadow-2xl ring-1 ring-ring/10">
        <div className="flex items-start justify-between gap-3 border-b border-border/10 px-3 py-2 shrink-0">
          <div>
            <h2 id="smart-match-title" className="text-sm font-semibold text-amber-400">
              Smart Match — Die inventory
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
              Target L×W×H: <span className="text-slate-200">{targetDims}</span> mm · ±{toleranceMm}{' '}
              mm · {rows.length} match{rows.length === 1 ? '' : 'es'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-card/10 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-auto flex-1 min-h-0">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">No dies within tolerance.</p>
          ) : (
            <table className="w-full text-left text-[11px] border-collapse">
              <thead className="sticky top-0 bg-zinc-950/95 border-b border-border/10 text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-2 py-1.5 font-semibold">Serial #</th>
                  <th className="px-2 py-1.5 font-semibold">Type</th>
                  <th className="px-2 py-1.5 font-semibold">Condition</th>
                  <th className="px-2 py-1.5 font-semibold">Age</th>
                  <th className="px-2 py-1.5 font-semibold">Location</th>
                  <th className="px-2 py-1.5 font-semibold">Dims mm</th>
                  <th className="px-2 py-1.5 font-semibold w-24"> </th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/5 hover:bg-card/[0.04]"
                  >
                    <td className="px-2 py-1 font-mono tabular-nums text-amber-200/95">
                      {r.serialNumber}
                    </td>
                    <td className="px-2 py-1 max-w-[10rem] truncate" title={r.type}>
                      {r.type}
                    </td>
                    <td className="px-2 py-1">
                      <span
                        className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${badgeClass(r.conditionBadge)}`}
                      >
                        {r.condition}
                      </span>
                    </td>
                    <td className="px-2 py-1 font-mono text-slate-400">{r.age}</td>
                    <td className="px-2 py-1 max-w-[8rem] truncate" title={r.location}>
                      {r.location}
                    </td>
                    <td className="px-2 py-1 font-mono text-slate-400 whitespace-nowrap">
                      {r.dimsMm}
                    </td>
                    <td className="px-2 py-1">
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => onSelect(r)}
                        className="px-2 py-1 rounded-md bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-primary-foreground text-[10px] font-semibold"
                      >
                        {busyId === r.id ? '…' : 'Link'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
