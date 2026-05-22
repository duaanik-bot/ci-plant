'use client'

import { useEffect, useState } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'

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

  return (
    <GlobalPopoutModal
      isOpen={open && !!poId}
      onClose={onClose}
      title="PO summary"
      metadata={
        data?.poNumber ? (
          <span className="font-designing-queue text-xs text-ds-warning">
            {data.poNumber}{data.customer?.name ? ` · ${data.customer.name}` : ''}
          </span>
        ) : loading ? (
          <span className="text-xs text-ds-ink-faint">Loading…</span>
        ) : null
      }
      mode="preview"
      size="md"
      zIndexClass="z-[92]"
    >
      <div className="space-y-4 text-sm text-ds-ink">
        {err ? <p className="text-sm text-[var(--error)]">{err}</p> : null}
        {loading ? <p className="text-sm text-ds-ink-faint">Loading…</p> : null}
        {!loading && data && (
          <>
            <div className="grid gap-3">
              <p>
                <span className="text-ds-ink-faint">Status / payment:</span>{' '}
                <span className="text-[var(--success)]">{String(data.status ?? '—')}</span>
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
              <div className="overflow-hidden rounded-ds-md border border-ds-line/40">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-ds-line/40 bg-ds-elevated text-ds-ink-muted">
                      <th className="px-2 py-2 font-medium">Product</th>
                      <th className="px-2 py-2 text-right">Qty</th>
                      <th className="px-2 py-2 text-right">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.lineItems ?? []).map((row) => (
                      <tr key={row.id} className="border-b border-ds-line/30 last:border-0">
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
    </GlobalPopoutModal>
  )
}
