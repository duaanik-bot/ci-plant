'use client'

import { useEffect, useState } from 'react'

const PROCUREMENT_MOVED_MESSAGE =
  'Procurement reports are available in the Procurement module; warehouse keeps the posted GRN stock ledger here.'

export function ReportsTab() {
  const [grnRows, setGrnRows] = useState<any[]>([])
  useEffect(() => {
    let cancelled = false
    fetch('/api/inventory/grn-inward-ledger', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : { rows: [] })
      .then((data) => { if (!cancelled) setGrnRows(Array.isArray(data.rows) ? data.rows : []) })
      .catch(() => { if (!cancelled) setGrnRows([]) })
    return () => { cancelled = true }
  }, [])
  const reportShortcuts = [
    'Stock Ledger',
    'Material Movement',
    'Shortage Visibility',
    'Reorder Alerts',
    'Open Reservations',
    'Ageing Analysis',
    'Warehouse Value',
    'Planning Requirements',
  ]

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          {reportShortcuts.map((label) => (
            <button
              key={label}
              type="button"
              className="rounded-ds-md bg-ds-elevated/60 px-3 py-2 text-left text-xs font-medium text-ds-ink hover:bg-ds-elevated"
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-ds-md border border-ds-line/40 bg-ds-elevated/35 px-4 py-3">
        <h3 className="text-sm font-semibold text-ds-ink">Procurement reports</h3>
        <p className="mt-1 text-sm text-ds-ink-muted">{PROCUREMENT_MOVED_MESSAGE}</p>
      </section>

      <section className="rounded-ds-md border border-ds-line/40 bg-background p-4">
        <h3 className="text-sm font-semibold text-ds-ink">Posted GRN inward ledger</h3>
        <p className="mt-1 text-xs text-ds-ink-muted">Read-only warehouse view of Procurement GRN stock postings.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-ds-ink-faint">
                {['Date', 'Material', 'Accepted', 'Rejected', 'GRN', 'PO', 'Supplier'].map((h) => <th key={h} className="pb-2 pr-3">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {grnRows.length === 0 ? (
                <tr><td colSpan={7} className="py-6 text-center text-ds-ink-muted">No posted GRN inward movements.</td></tr>
              ) : grnRows.map((r) => (
                <tr key={r.id} className="border-t border-ds-line/30">
                  <td className="py-2 pr-3 text-xs text-ds-ink-muted">{new Date(r.date).toLocaleDateString()}</td>
                  <td className="py-2 pr-3"><span className="font-medium">{r.materialCode}</span><p className="text-xs text-ds-ink-muted">{r.description}</p></td>
                  <td className="py-2 pr-3 tabular-nums">{Number(r.acceptedQty).toLocaleString('en-IN')} {r.uom}</td>
                  <td className="py-2 pr-3 tabular-nums text-[var(--error)]">{Number(r.rejectedQty).toLocaleString('en-IN')} {r.uom}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.grnReference}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.poReference}</td>
                  <td className="py-2 pr-3">{r.supplier}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
