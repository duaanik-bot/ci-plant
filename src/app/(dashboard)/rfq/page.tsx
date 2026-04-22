'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type RfqItem = {
  id: string
  rfqNumber: string
  status: string
  productName: string
  packType: string
  estimatedVolume: number | null
  createdAt: string
  customer: { name: string }
}

export default function RfqPage() {
  const [items, setItems] = useState<RfqItem[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('')

  useEffect(() => {
    setLoading(true)
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''
    fetch(`/api/rfq${qs}`)
      .then((r) => r.json())
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [statusFilter])

  if (loading) {
    return <div className="p-4 text-ds-ink-muted">Loading RFQs…</div>
  }

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-ds-warning">RFQ Pipeline</h1>
        <Link
          href="/rfq/new"
          className="px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm font-medium"
        >
          New RFQ
        </Link>
      </div>

      <div className="mb-4 flex gap-2 items-center">
        <label className="text-sm text-ds-ink-muted">Status</label>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg bg-ds-elevated border border-ds-line/60 text-sm"
        >
          <option value="">All</option>
          <option value="received">RFQ received</option>
          <option value="feasibility">Feasibility</option>
          <option value="quoted">Quoted</option>
          <option value="po_received">PO received</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-ds-line/50">
        <table className="w-full text-sm">
          <thead className="bg-ds-elevated text-left">
            <tr>
              <th className="px-4 py-2">RFQ #</th>
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Product</th>
              <th className="px-4 py-2">Pack Type</th>
              <th className="px-4 py-2">Volume</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Days Open</th>
              <th className="px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ds-line/40">
            {items.map((rfq) => {
              const created = new Date(rfq.createdAt)
              const daysOpen = Math.max(
                0,
                Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24))
              )
              return (
                <tr key={rfq.id} className="hover:bg-ds-elevated/60">
                  <td className="px-4 py-2 font-mono text-ds-warning">{rfq.rfqNumber}</td>
                  <td className="px-4 py-2">{rfq.customer?.name}</td>
                  <td className="px-4 py-2">{rfq.productName}</td>
                  <td className="px-4 py-2">{rfq.packType}</td>
                  <td className="px-4 py-2">
                    {rfq.estimatedVolume ? rfq.estimatedVolume.toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <span className="px-2 py-0.5 rounded text-xs bg-ds-elevated border border-ds-line/60 text-ds-ink">
                      {rfq.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ds-ink-muted">{daysOpen}</td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/rfq/${rfq.id}`}
                      className="text-ds-warning hover:underline text-xs"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              )
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-ds-ink-faint">
                  No RFQs found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

