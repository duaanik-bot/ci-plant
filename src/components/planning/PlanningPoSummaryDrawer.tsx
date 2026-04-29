'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

const shell = 'border-l border-[#334155] bg-[#1E293B] shadow-[-10px_0_40px_rgba(0,0,0,0.25)]'
const mono = 'font-designing-queue tabular-nums text-sm font-semibold'

type LineRow = { id: string; cartonName: string; quantity: number; rate: number | null; gstPct: number }

export function PlanningPoSummaryDrawer({
  open,
  poId,
  onClose,
}: {
  open: boolean
  poId: string | null
  onClose: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<{
    poNumber?: string
    status?: string
    lineItems?: LineRow[]
    totalValueInr?: number
    billTo?: string
    shipTo?: string
    paymentStatus?: string
    customer?: { name?: string }
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !poId) {
      setData(null)
      setErr(null)
      return
    }
    setLoading(true)
    setErr(null)
    void fetch(`/api/planning/po-summary/${poId}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { error?: string } & typeof data
        if (!r.ok) throw new Error(j.error ?? 'Failed to load')
        setData(j)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Error'))
      .finally(() => setLoading(false))
  }, [open, poId])

  if (!open || !poId) return null

  return (
    <div className="fixed inset-0 z-[92] flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        aria-label="Close"
        onClick={onClose}
      />
      <aside
        className={`relative flex h-full w-full max-w-[500px] flex-col ${shell}`}
        role="dialog"
        aria-modal="true"
        aria-label="PO summary"
      >
        <div className="flex items-start justify-between gap-2 border-b border-[#334155] bg-[#0F172A] px-4 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ds-ink-faint">PO summary</p>
            <h2 className="truncate pr-2 text-sm font-semibold text-ds-warning">
              {data?.poNumber ?? (loading ? '…' : '—')}
            </h2>
            <p className="mt-0.5 truncate text-xs text-ds-ink-muted">
              {data?.customer?.name ?? '—'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-ds-ink-muted hover:bg-[#1E293B] hover:text-ds-ink"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {err ? <p className="text-sm text-rose-400">{err}</p> : null}
          {loading ? <p className="text-sm text-ds-ink-faint">Loading…</p> : null}
          {!loading && data && (
            <>
              <div className="grid gap-3 text-sm text-ds-ink">
                <p>
                  <span className="text-ds-ink-faint">Status / payment:</span>{' '}
                  <span className="text-emerald-400">{String(data.status ?? '—')}</span>
                </p>
                <p>
                  <span className="text-ds-ink-faint">Total (est. w/ GST on lines):</span>{' '}
                  <span className={`text-ds-warning ${mono}`}>
                    {data.totalValueInr != null ? `₹${data.totalValueInr.toLocaleString('en-IN')}` : '—'}
                  </span>
                </p>
                <p className="whitespace-pre-wrap text-ds-ink-muted">
                  <span className="text-ds-ink-faint">Bill-to:</span> {String(data.billTo ?? '—')}
                </p>
                <p className="whitespace-pre-wrap text-ds-ink-muted">
                  <span className="text-ds-ink-faint">Ship / delivery note:</span> {String(data.shipTo ?? '—')}
                </p>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ds-ink-faint">
                  PO line items
                </p>
                <div className="overflow-hidden rounded border border-[#334155]">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[#334155] bg-[#0F172A] text-ds-ink-muted">
                        <th className="px-2 py-2 font-medium">Product</th>
                        <th className="px-2 py-2 text-right">Qty</th>
                        <th className="px-2 py-2 text-right">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.lineItems ?? []).map((row) => (
                        <tr key={row.id} className="border-b border-[#334155] last:border-0">
                          <td className="px-2 py-2 text-ds-ink">{row?.cartonName ?? '—'}</td>
                          <td className={`px-2 py-2 text-right ${mono}`}>
                            {row?.quantity != null ? row.quantity.toLocaleString('en-IN') : '—'}
                          </td>
                          <td className={`px-2 py-2 text-right ${mono}`}>
                            {row?.rate != null ? row.rate : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
