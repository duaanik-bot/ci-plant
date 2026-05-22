'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/shared/PageHeader'

type FgExcessRow = {
  id: string
  materialCode: string
  description: string
  unit: string
  qtyFg: number
  fgValueInr: number
  boxNumber: string
  boxAgeDays: number | null
  estimatedBoxes: number
  customerHints: {
    customerId: string
    customerName: string
    poNumber: string
    poDate: string
    qtyOrdered: number
  }[]
}

export default function FgWarehousePage() {
  const [rows, setRows] = useState<FgExcessRow[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/inventory/fg-excess${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`)
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false))
  }, [search])

  const totalFg = useMemo(() => rows.reduce((s, r) => s + Number(r.qtyFg || 0), 0), [rows])
  const totalVal = useMemo(() => rows.reduce((s, r) => s + Number(r.fgValueInr || 0), 0), [rows])

  return (
    <div className="w-full px-4 py-3">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="FG Warehouse (Finished Goods)"
          subtitle="Dedicated finished-goods stock module, separated from paper warehouse."
        />
        <Link href="/inventory" className="rounded border border-ds-line/50 px-3 py-2 text-xs text-ds-ink hover:bg-ds-main/50">
          Open Paper Warehouse
        </Link>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
        <div className="rounded border border-ds-line/40 bg-background px-3 py-2">FG Rows <div className="text-sm text-ds-ink">{rows.length}</div></div>
        <div className="rounded border border-ds-line/40 bg-background px-3 py-2">Total FG <div className="text-sm text-ds-ink">{totalFg.toLocaleString('en-IN')}</div></div>
        <div className="rounded border border-ds-line/40 bg-background px-3 py-2">Estimated value <div className="text-sm text-ds-ink">₹{totalVal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div></div>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search material / product"
        className="mb-3 w-full max-w-sm rounded-ds-md border border-ds-line/50 bg-background px-3 py-2 text-sm"
      />

      <div className="overflow-x-auto rounded-ds-md border border-ds-line/40">
        <table className="w-full text-sm">
          <thead className="bg-background text-left border-b border-ds-line/40">
            <tr className="text-ds-ink-muted text-xs uppercase tracking-wide">
              <th className="px-3 py-2">Material</th>
              <th className="px-3 py-2">FG Qty</th>
              <th className="px-3 py-2">Box no.</th>
              <th className="px-3 py-2">Box age</th>
              <th className="px-3 py-2">Brands</th>
              <th className="px-3 py-2">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ds-card">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-ds-main/40">
                <td className="px-3 py-2">
                  <p className="text-sm text-ds-ink">{row.materialCode}</p>
                  <p className="text-xs text-ds-ink-faint">{row.description}</p>
                </td>
                <td className="px-3 py-2 text-ds-ink">{row.qtyFg.toLocaleString('en-IN')} {row.unit}</td>
                <td className="px-3 py-2">{row.boxNumber}</td>
                <td className="px-3 py-2 text-xs text-ds-ink-faint">{row.boxAgeDays != null ? `${row.boxAgeDays} days` : '—'}</td>
                <td className="px-3 py-2 text-xs text-ds-ink-faint">{row.customerHints.length ? row.customerHints.map((c) => c.customerName).join(', ') : '-'}</td>
                <td className="px-3 py-2">₹{row.fgValueInr.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 ? <p className="p-6 text-center text-sm text-ds-ink-faint">No FG rows found.</p> : null}
      </div>
    </div>
  )
}
