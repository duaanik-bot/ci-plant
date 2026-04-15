'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'

type ArtworkQueueItem = {
  id: string
  cartonName: string
  artworkCode: string | null
  setNumber: string | null
  planningStatus: string
  artworkStatusLabel: string
  approvalsComplete: boolean
  prePressFinalized: boolean
  po: {
    poNumber: string
    customer: { name: string }
    poDate: string | null
  }
}

export default function ArtworkApprovalsPage() {
  const [items, setItems] = useState<ArtworkQueueItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/designing/po-lines')
      .then((r) => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) setItems(data as ArtworkQueueItem[])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const statusBadge = (item: ArtworkQueueItem) => {
    if (item.prePressFinalized) {
      return (
        <span className="px-2 py-0.5 rounded text-xs bg-emerald-900/50 text-emerald-300">
          Sent to Plate Hub ✓
        </span>
      )
    }
    if (item.approvalsComplete) {
      return (
        <span className="px-2 py-0.5 rounded text-xs bg-blue-900/50 text-blue-300">
          Approved — ready to finalize
        </span>
      )
    }
    return (
      <span className="px-2 py-0.5 rounded text-xs bg-amber-900/50 text-amber-300">
        {item.artworkStatusLabel || 'Awaiting approval'}
      </span>
    )
  }

  return (
    <section className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-amber-400">Artwork Gate</h1>
          <p className="text-sm text-slate-400">
            Review artwork locks and push finalized jobs to the Plate Hub.
          </p>
        </div>
        <Link
          href="/orders/designing"
          className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-500"
        >
          Full Designing Queue
        </Link>
      </div>

      {loading ? (
        <div className="text-slate-400 py-8 text-center">Loading artwork queue…</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-8 text-center text-slate-400 text-sm">
          No items in the artwork queue.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">PO #</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Carton / Product</th>
                <th className="px-4 py-2 font-medium">AW Code</th>
                <th className="px-4 py-2 font-medium">Set #</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">PO Date</th>
                <th className="px-4 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-800/40">
                  <td className="px-4 py-2 font-mono text-amber-400 whitespace-nowrap">
                    {item.po.poNumber}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{item.po.customer.name}</td>
                  <td className="px-4 py-2">{item.cartonName}</td>
                  <td className="px-4 py-2 font-mono text-xs">{item.artworkCode || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs">{item.setNumber || '—'}</td>
                  <td className="px-4 py-2">{statusBadge(item)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-slate-400 text-xs">
                    {item.po.poDate ? format(new Date(item.po.poDate), 'dd MMM yyyy') : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/orders/designing/${item.id}`}
                      className="text-amber-400 hover:underline text-sm font-medium"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
