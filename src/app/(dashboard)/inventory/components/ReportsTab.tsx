'use client'

import { useState, useEffect } from 'react'

type ReportsData = {
  spendByVendor: { vendorName: string; totalInr: number; poCount: number }[]
  receiptAccuracy: { vendorName: string; orderedKg: number; receivedKg: number; accuracyPct: number }[]
  leadTimeTrend: { month: string; avgDays: number }[]
}

const nf = new Intl.NumberFormat('en-IN')

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ds-line/30">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

export function ReportsTab() {
  const [data, setData] = useState<ReportsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)

  useEffect(() => {
    if (fetched) return
    setFetched(true)
    setLoading(true)
    fetch('/api/inventory/paper-warehouse/reports')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [fetched])

  if (loading) return <div className="py-8 text-center text-sm text-ds-ink-muted">Loading reports…</div>
  if (!data) return <div className="py-8 text-center text-sm text-ds-ink-muted">No data.</div>

  const maxSpend = Math.max(...data.spendByVendor.map((v) => v.totalInr), 1)

  return (
    <div className="flex flex-col gap-8">
      {/* Spend by vendor */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ds-ink">Spend by Vendor — Last 90 days</h3>
        <div className="flex flex-col gap-2">
          {data.spendByVendor.slice(0, 8).map((v) => (
            <div key={v.vendorName}>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-ds-ink">{v.vendorName}</span>
                <span className="tabular-nums text-ds-ink-muted">₹{nf.format(Math.round(v.totalInr / 1000))}k · {v.poCount} PO{v.poCount !== 1 ? 's' : ''}</span>
              </div>
              <Bar pct={(v.totalInr / maxSpend) * 100} color="bg-ds-primary" />
            </div>
          ))}
        </div>
      </section>

      {/* Receipt accuracy */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ds-ink">Receipt Accuracy by Vendor</h3>
        <div className="flex flex-col gap-2">
          {data.receiptAccuracy.map((v) => (
            <div key={v.vendorName}>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-ds-ink">{v.vendorName}</span>
                <span className={`tabular-nums font-medium ${v.accuracyPct >= 95 ? 'text-ds-success' : v.accuracyPct >= 80 ? 'text-ds-warning' : 'text-ds-error'}`}>
                  {v.accuracyPct}%
                </span>
              </div>
              <Bar pct={v.accuracyPct} color={v.accuracyPct >= 95 ? 'bg-ds-success' : v.accuracyPct >= 80 ? 'bg-ds-warning' : 'bg-ds-error'} />
            </div>
          ))}
        </div>
      </section>

      {/* Lead time trend */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ds-ink">Avg Lead Time — Last 6 Months</h3>
        <div className="flex items-end gap-3">
          {data.leadTimeTrend.map((m) => (
            <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-xs font-medium tabular-nums text-ds-ink">{m.avgDays}d</span>
              <div
                className="w-full rounded-t-ds-sm bg-ds-primary/60"
                style={{ height: `${Math.max(8, m.avgDays * 2)}px` }}
              />
              <span className="text-[10px] text-ds-ink-faint">{m.month.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
