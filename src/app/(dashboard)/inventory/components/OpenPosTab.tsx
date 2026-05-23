'use client'

import { useState, useEffect } from 'react'
import { cn } from '@/lib/cn'

type OpenPoRow = {
  id: string; poNumber: string; vendorName: string; materialCode: string | null
  orderedKg: number; receivedKg: number; pendingKg: number
  requiredDeliveryDate: string | null; status: string; logisticsStatus: string | null
  daysOverdue: number | null; linkedPrIds: string[]
}

function useOpenPos() {
  const [rows, setRows] = useState<OpenPoRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch('/api/inventory/paper-warehouse/open-pos')
      .then((r) => r.json())
      .then(setRows)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return { rows, loading }
}

const nf = new Intl.NumberFormat('en-IN')

const STATUS_FILTERS = ['All', 'Dispatched', 'In Transit', 'At Gate', 'Overdue'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

export function OpenPosTab() {
  const { rows, loading } = useOpenPos()
  const [filter, setFilter] = useState<StatusFilter>('All')
  const [search, setSearch] = useState('')

  const filtered = rows.filter((r) => {
    if (filter === 'Overdue') return (r.daysOverdue ?? 0) > 0 && r.pendingKg > 0
    if (filter === 'Dispatched') return r.logisticsStatus === 'mill_dispatched'
    if (filter === 'In Transit') return r.logisticsStatus === 'in_transit'
    if (filter === 'At Gate') return r.logisticsStatus === 'at_gate'
    return true
  }).filter((r) => {
    if (!search) return true
    const q = search.toLowerCase()
    return r.poNumber.toLowerCase().includes(q) || (r.vendorName ?? '').toLowerCase().includes(q)
  })

  if (loading) return <div className="py-8 text-center text-sm text-ds-ink-muted">Loading…</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              filter === f ? 'bg-ds-primary text-white' : 'bg-ds-elevated text-ds-ink-muted hover:text-ds-ink',
            )}
          >
            {f}
          </button>
        ))}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search PO or vendor…"
          className="ml-auto w-48 rounded-ds-md bg-ds-elevated px-3 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ds-primary"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-ds-ink-muted">No open purchase orders.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              <th className="pb-2 pr-4">PO Number</th>
              <th className="pb-2 pr-4">Vendor</th>
              <th className="pb-2 pr-4">Material</th>
              <th className="pb-2 pr-4 text-right">Ordered kg</th>
              <th className="pb-2 pr-4 text-right">Received kg</th>
              <th className="pb-2 pr-4 text-right">Pending kg</th>
              <th className="pb-2 pr-4">ETA</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const isOverdue = (r.daysOverdue ?? 0) > 0 && r.pendingKg > 0
              const pct = r.orderedKg > 0 ? (r.receivedKg / r.orderedKg) * 100 : 0
              return (
                <tr
                  key={r.id}
                  className={cn(
                    '',
                    isOverdue && 'bg-ds-error/5',
                  )}
                >
                  <td className="py-2 pr-4 font-medium text-ds-ink">{r.poNumber}</td>
                  <td className="py-2 pr-4 text-ds-ink-muted">{r.vendorName}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-ds-ink">{r.materialCode ?? '—'}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{nf.format(Math.round(r.orderedKg))}</td>
                  <td className="py-2 pr-4 text-right">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="tabular-nums">{nf.format(Math.round(r.receivedKg))}</span>
                      <div className="h-1 w-16 overflow-hidden rounded-full bg-ds-line/30">
                        <div className={cn('h-full', pct >= 100 ? 'bg-ds-success' : 'bg-ds-warning')} style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{nf.format(Math.round(r.pendingKg))}</td>
                  <td className={cn('py-2 pr-4', isOverdue && 'font-medium text-ds-error')}>
                    {r.requiredDeliveryDate
                      ? new Date(r.requiredDeliveryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                      : '—'}
                    {isOverdue && ` (+${r.daysOverdue}d)`}
                  </td>
                  <td className="py-2">
                    <span className="rounded-full bg-ds-elevated px-2 py-0.5 text-[11px] font-medium text-ds-ink-muted capitalize">
                      {r.logisticsStatus?.replace('_', ' ') ?? r.status}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
