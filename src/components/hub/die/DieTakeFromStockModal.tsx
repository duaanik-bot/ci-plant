'use client'

import { useCallback, useEffect, useState } from 'react'
import type { PastingStyle } from '@prisma/client'
import { safeJsonParse } from '@/lib/safe-json'
import { pastingStyleLabel } from '@/lib/pasting-style'

export type DieStockCandidate = {
  id: string
  serialLabel: string
  displayCode: string
  pastingStyle: PastingStyle | null
  dieMake: 'local' | 'laser'
  location: string | null
  reuseCount: number
  impressionCount: number
}

export function DieTakeFromStockModal({
  triageDyeId,
  onClose,
  onConfirm,
  saving,
}: {
  triageDyeId: string | null
  onClose: () => void
  onConfirm: (inventoryDyeId: string) => Promise<void>
  saving: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [triageCode, setTriageCode] = useState('')
  const [candidates, setCandidates] = useState<DieStockCandidate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!triageDyeId?.trim()) return
    setLoading(true)
    setError(null)
    setHint(null)
    try {
      const r = await fetch(
        `/api/tooling-hub/dies/take-from-stock?triageDyeId=${encodeURIComponent(triageDyeId)}`,
      )
      const t = await r.text()
      const j = safeJsonParse<{
        error?: string
        triageDisplayCode?: string
        candidates?: DieStockCandidate[]
        hint?: string
      }>(t, {})
      if (!r.ok) {
        setError(j.error ?? 'Failed to load inventory')
        setCandidates([])
        setTriageCode('')
        return
      }
      setTriageCode(j.triageDisplayCode ?? '')
      setCandidates(Array.isArray(j.candidates) ? j.candidates : [])
      setHint(typeof j.hint === 'string' ? j.hint : null)
      setSelectedId(null)
    } catch {
      setError('Failed to load')
      setCandidates([])
    } finally {
      setLoading(false)
    }
  }, [triageDyeId])

  useEffect(() => {
    void load()
  }, [load])

  if (!triageDyeId) return null

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-background/85 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="ci-hub-modal-panel max-w-3xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0">
          <h3 className="ci-hub-modal-title">Take from stock</h3>
          <p className="text-ds-ink-muted text-[11px] leading-snug mt-2">
            Matching dies share the same L×W×H as triage job{' '}
            <span className="text-ds-warning font-mono">{triageCode || '…'}</span>. Pull one into
            custody floor (<span className="text-ds-warning">Source: Rack</span>). The triage
            placeholder will be archived.
          </p>
        </div>

        {loading ? (
          <p className="text-sm text-neutral-500 shrink-0">Loading rack matches…</p>
        ) : error ? (
          <p className="text-sm text-rose-400 shrink-0">{error}</p>
        ) : hint && candidates.length === 0 ? (
          <p className="text-sm text-ds-warning shrink-0">{hint}</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-rose-400 shrink-0">
            No dies in live inventory with identical L×W×H.
          </p>
        ) : (
          <div className="overflow-auto rounded-lg border border-ds-line/40 min-h-0">
            <table className="w-full text-[11px] border-collapse">
              <thead className="sticky top-0 bg-ds-main z-[1]">
                <tr className="text-left text-neutral-500 border-b border-ds-line/40">
                  <th className="py-1.5 px-2 w-10 font-semibold uppercase tracking-wide">Sel</th>
                  <th className="py-1.5 px-2 font-semibold uppercase tracking-wide">Serial</th>
                  <th className="py-1.5 px-2 font-semibold uppercase tracking-wide">Pasting</th>
                  <th className="py-1.5 px-2 font-semibold uppercase tracking-wide">Make</th>
                  <th className="py-1.5 px-2 font-semibold uppercase tracking-wide">Rack / slot</th>
                  <th className="py-1.5 px-2 font-semibold uppercase tracking-wide text-right">
                    Star ledger
                  </th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id} className="border-b border-ds-line/50 align-top">
                    <td className="py-1.5 px-2">
                      <input
                        type="radio"
                        name="die-stock-pick"
                        className="border-ds-line/50"
                        checked={selectedId === c.id}
                        onChange={() => setSelectedId(c.id)}
                      />
                    </td>
                    <td className="py-1.5 px-2 text-ds-warning font-mono font-semibold whitespace-nowrap">
                      {c.serialLabel}
                    </td>
                    <td className="py-1.5 px-2 text-neutral-400">{pastingStyleLabel(c.pastingStyle)}</td>
                    <td className="py-1.5 px-2 text-neutral-400 capitalize">{c.dieMake}</td>
                    <td className="py-1.5 px-2 text-neutral-400 whitespace-nowrap">
                      {c.location?.trim() || '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right text-neutral-500 tabular-nums">
                      Imp {c.impressionCount} · Cycles {c.reuseCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1 shrink-0">
          <button
            type="button"
            className="px-3 py-2 rounded border border-ds-line/50 text-neutral-400"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || !selectedId || candidates.length === 0}
            className="ci-btn-save-industrial disabled:opacity-50"
            onClick={() => selectedId && void onConfirm(selectedId)}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
