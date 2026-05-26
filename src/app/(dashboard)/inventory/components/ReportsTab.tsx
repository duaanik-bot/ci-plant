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
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'spend' | 'poCount'>('spend')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

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

  const q = search.trim().toLowerCase()
  const spendRows = data.spendByVendor
    .filter((v) => !q || v.vendorName.toLowerCase().includes(q))
    .sort((a, b) => (sort === 'spend' ? b.totalInr - a.totalInr : b.poCount - a.poCount))
  const maxSpend = Math.max(...spendRows.map((v) => v.totalInr), 1)
  const reportShortcuts = [
    'Open Purchase Orders',
    'Incoming Deliveries',
    'Vendor Commitments',
    'Shortage Report',
    'Procurement Summary',
    'Material Movement',
    'Open Reservations',
    'Pending Receipts',
  ]

  function exportCsv() {
    const lines = ['Vendor,Total INR,PO Count', ...spendRows.map((v) => `"${v.vendorName}",${v.totalInr},${v.poCount}`)]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'procurement-summary.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          {reportShortcuts.map((label) => (
            <button key={label} type="button" className="rounded-ds-md bg-ds-elevated/60 px-3 py-2 text-left text-xs font-medium text-ds-ink hover:bg-ds-elevated">
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reports..."
            className="w-56 rounded-ds-md bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as 'spend' | 'poCount')} className="rounded-ds-md bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink">
            <option value="spend">Sort by spend</option>
            <option value="poCount">Sort by PO count</option>
          </select>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-ds-md bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink" />
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-ds-md bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink" />
          <button type="button" onClick={exportCsv} className="rounded-ds-md bg-ds-elevated px-3 py-1.5 text-sm font-medium text-ds-ink hover:bg-ds-elevated/80">
            Export
          </button>
        </div>
      </section>

      {/* Spend by vendor */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ds-ink">Spend by Vendor — Last 90 days</h3>
        <div className="flex flex-col gap-2">
          {spendRows.slice(0, 8).map((v) => (
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
