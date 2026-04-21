'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

type PendingItem = {
  id: string
  jobNumber: string
  productName: string
  materialCode: string
  qtyApproved: number
  qtyAlreadyIssued: number
  qtyRequested: number
  unit: string
  reasonCode: string | null
  issuedAt: string
}

export default function ApproveExcessListPage() {
  const [list, setList] = useState<PendingItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/sheet-issues/pending')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => setList([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold text-amber-400 mb-4">Approve Excess Requests</h1>
      <Link href="/stores/issue" className="text-slate-400 hover:text-foreground text-sm mb-4 inline-block">
        ← Issue Sheets
      </Link>

      {list.length === 0 ? (
        <p className="text-slate-500">No pending excess requests.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((item) => (
            <li key={item.id}>
              <Link
                href={`/stores/approve-excess/${item.id}`}
                className="block p-4 rounded-lg bg-slate-800 border border-slate-600 hover:border-amber-500/50"
              >
                <p className="font-mono text-amber-400">{item.jobNumber}</p>
                <p className="text-slate-300">{item.productName} · {item.materialCode}</p>
                <p className="text-slate-500 text-sm">
                  Approved: {item.qtyApproved} · Issued: {item.qtyAlreadyIssued} · Requesting: {item.qtyRequested} {item.unit}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
