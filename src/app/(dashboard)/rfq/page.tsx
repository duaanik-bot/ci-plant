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
    return <div className="p-4 text-slate-400">Loading RFQs…</div>
  }

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-amber-400">RFQ Pipeline</h1>
        <Link
          href="/rfq/new"
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
        >
          New RFQ
        </Link>
      </div>

      <div className="mb-4 flex gap-2 items-center">
        <label className="text-sm text-slate-400">Status</label>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-sm"
        >
          <option value="">All</option>
          <option value="received">RFQ received</option>
          <option value="feasibility">Feasibility</option>
          <option value="quoted">Quoted</option>
          <option value="po_received">PO received</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-left">
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
          <tbody className="divide-y divide-slate-700">
            {items.map((rfq) => {
              const created = new Date(rfq.createdAt)
              const daysOpen = Math.max(
                0,
                Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24))
              )
              return (
                <tr key={rfq.id} className="hover:bg-slate-800/60">
                  <td className="px-4 py-2 font-mono text-amber-300">{rfq.rfqNumber}</td>
                  <td className="px-4 py-2">{rfq.customer?.name}</td>
                  <td className="px-4 py-2">{rfq.productName}</td>
                  <td className="px-4 py-2">{rfq.packType}</td>
                  <td className="px-4 py-2">
                    {rfq.estimatedVolume ? rfq.estimatedVolume.toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <span className="px-2 py-0.5 rounded text-xs bg-slate-800 border border-slate-600 text-slate-200">
                      {rfq.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-400">{daysOpen}</td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/rfq/${rfq.id}`}
                      className="text-amber-400 hover:underline text-xs"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              )
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
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

