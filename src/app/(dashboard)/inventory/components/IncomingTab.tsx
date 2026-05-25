'use client'

import { useState, useEffect } from 'react'
import { cn } from '@/lib/cn'

type OpenPoRow = {
  id: string; poNumber: string; vendorName: string; materialCode: string | null
  orderedKg: number; receivedKg: number; pendingKg: number
  requiredDeliveryDate: string | null; status: string; logisticsStatus: string | null
  daysOverdue: number | null
}

const nf = new Intl.NumberFormat('en-IN')

function isoWeekLabel(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function weekKey(dateStr: string): string {
  const d = new Date(dateStr)
  const day = d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() - ((day + 6) % 7))
  return monday.toISOString().slice(0, 10)
}

export function IncomingTab() {
  const [rows, setRows] = useState<OpenPoRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/inventory/paper-warehouse/open-pos')
      .then((r) => r.json())
      .then((data: OpenPoRow[]) => {
        const withDate = data
          .filter((r) => !!r.requiredDeliveryDate)
          .sort((a, b) => (a.requiredDeliveryDate! < b.requiredDeliveryDate! ? -1 : 1))
        setRows(withDate)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="py-8 text-center text-sm text-ds-ink-muted">Loading…</div>
  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-ds-ink-muted">
        No incoming deliveries scheduled.
      </div>
    )
  }

  // Group by ISO week
  const weeks = new Map<string, OpenPoRow[]>()
  for (const r of rows) {
    const key = weekKey(r.requiredDeliveryDate!)
    const arr = weeks.get(key) ?? []
    arr.push(r)
    weeks.set(key, arr)
  }

  return (
    <div className="flex flex-col gap-6">
      {Array.from(weeks.entries()).map(([weekStart, wRows]) => {
        const totalKg = wRows.reduce((s, r) => s + r.pendingKg, 0)
        return (
          <div key={weekStart}>
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-sm font-semibold text-ds-ink">Week of {isoWeekLabel(weekStart)}</span>
              <span className="text-xs text-ds-ink-muted">
                {wRows.length} PO{wRows.length !== 1 ? 's' : ''} · {nf.format(Math.round(totalKg))} kg expected
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {wRows.map((r) => {
                const isOverdue = (r.daysOverdue ?? 0) > 0
                return (
                  <div
                    key={r.id}
                    className={cn(
                      'flex items-center justify-between rounded-ds-md px-3 py-2',
                      isOverdue && 'bg-ds-error/5',
                    )}
                  >
                    <div>
                      <span className="font-medium text-ds-ink">{r.vendorName}</span>
                      {r.materialCode && (
                        <span className="ml-2 font-mono text-xs text-ds-ink-muted">{r.materialCode}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="tabular-nums text-sm text-ds-ink">{nf.format(Math.round(r.pendingKg))} kg</span>
                      <span className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
                        isOverdue ? 'bg-ds-error/10 text-ds-error' : 'bg-ds-elevated text-ds-ink-muted',
                      )}>
                        {isOverdue
                          ? `Overdue +${r.daysOverdue}d`
                          : r.logisticsStatus?.replace('_', ' ') ?? r.status}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
