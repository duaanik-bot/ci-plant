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
      <span className="px-2 py-0.5 rounded text-xs bg-ds-warning/12 text-ds-warning">
        {item.artworkStatusLabel || 'Awaiting approval'}
      </span>
    )
  }

  return (
    <section className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ds-warning">Artwork Gate</h1>
          <p className="text-sm text-ds-ink-muted">
            Review artwork locks and push finalized jobs to the Plate Hub.
          </p>
        </div>
        <Link
          href="/orders/designing"
          className="rounded-md bg-blue-600 px-3 py-2 text-sm text-primary-foreground hover:bg-blue-500"
        >
          Full Designing Queue
        </Link>
      </div>

      {loading ? (
        <div className="text-ds-ink-muted py-8 text-center">Loading artwork queue…</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-ds-line/40 bg-ds-main/40 p-8 text-center text-ds-ink-muted text-sm">
          No items in the artwork queue.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-ds-line/50">
          <table className="w-full text-sm">
            <thead className="bg-ds-elevated text-left">
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
            <tbody className="divide-y divide-ds-line/40">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-ds-elevated/40">
                  <td className="px-4 py-2 font-mono text-ds-warning whitespace-nowrap">
                    {item.po.poNumber}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{item.po.customer.name}</td>
                  <td className="px-4 py-2">{item.cartonName}</td>
                  <td className="px-4 py-2 font-mono text-xs">{item.artworkCode || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs">{item.setNumber || '—'}</td>
                  <td className="px-4 py-2">{statusBadge(item)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-ds-ink-muted text-xs">
                    {item.po.poDate ? format(new Date(item.po.poDate), 'dd MMM yyyy') : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/orders/designing/${item.id}`}
                      className="text-ds-warning hover:underline text-sm font-medium"
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
