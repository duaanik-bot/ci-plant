'use client'

import { useState } from 'react'

type ShortageMatch = {
  shortageId: string
  jobCardId: string
  jobCardNumber: number | null
  planningId: string | null
  remainingQty: number
  shortageQty: number
  purchaseReqId: string | null
  linkedCartonId: string | null
  linkedCartonName: string | null
}

type Props = {
  open: boolean
  grnMovementId: string
  materialCode: string
  receivedQty: number
  matches: ShortageMatch[]
  onClose: () => void
  onAllocated?: () => void
}

export function GrnAllocationPrompt({ open, grnMovementId, materialCode, receivedQty, matches, onClose, onAllocated }: Props) {
  const [allocating, setAllocating] = useState<string | null>(null)

  if (!open) return null

  async function allocate(shortageId: string) {
    setAllocating(shortageId)
    try {
      const res = await fetch('/api/inventory/grn/allocate-shortage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grnId: grnMovementId, shortageId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Allocation failed')
      onAllocated?.()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Allocation failed')
    } finally {
      setAllocating(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-ds-lg border border-ds-line/60 bg-ds-card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-ds-ink">Allocate GRN to shortages</h3>
            <p className="text-xs text-ds-ink-faint">Material: {materialCode} · Received qty: {receivedQty.toLocaleString('en-IN')}</p>
          </div>
          <button onClick={onClose} className="rounded border border-ds-line/50 px-2 py-1 text-xs text-ds-ink">Close</button>
        </div>

        <div className="max-h-[360px] overflow-auto rounded border border-ds-line/40">
          <table className="w-full text-sm">
            <thead className="bg-ds-elevated/30 text-left text-xs uppercase tracking-wide text-ds-ink-faint">
              <tr>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Carton</th>
                <th className="px-3 py-2">Shortage qty</th>
                <th className="px-3 py-2">Allocate qty</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ds-line/30">
              {matches.map((m) => {
                const allocQty = Math.min(receivedQty, m.remainingQty)
                return (
                  <tr key={m.shortageId}>
                    <td className="px-3 py-2 text-xs text-ds-ink">{m.jobCardNumber ? `JC#${m.jobCardNumber}` : 'Legacy / reference missing'}</td>
                    <td className="px-3 py-2 text-xs text-ds-ink-muted">{m.linkedCartonName ?? 'Legacy / reference missing'}</td>
                    <td className="px-3 py-2 text-xs text-ds-ink">{m.remainingQty.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2 text-xs text-ds-ink">{allocQty.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => void allocate(m.shortageId)}
                        disabled={allocating != null}
                        className="rounded border border-ds-line/50 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/50 disabled:opacity-40"
                      >
                        {allocating === m.shortageId ? 'Allocating…' : 'Allocate'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
