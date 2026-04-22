'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type Bill = {
  id: string
  billNumber: string
  billDate: string
  customer: { id: string; name: string }
  subtotal: number
  gstAmount: number
  totalAmount: number
  status: string
}

type Customer = { id: string; name: string }

export default function BillingPage() {
  const [list, setList] = useState<Bill[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [customerId, setCustomerId] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    const params = new URLSearchParams()
    if (customerId) params.set('customerId', customerId)
    if (status) params.set('status', status)
    fetch(`/api/bills?${params}`)
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load bills'))
      .finally(() => setLoading(false))
  }, [customerId, status])

  useEffect(() => {
    fetch('/api/masters/customers')
      .then((r) => r.json())
      .then((data) => setCustomers(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  if (loading) return <div className="p-4 text-ds-ink-muted">Loading…</div>

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ds-warning">Billing</h1>
        <Link
          href="/billing/new"
          className="px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm font-medium"
        >
          New bill
        </Link>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground min-w-[180px]"
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="paid">Paid</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-ds-line/50">
        <table className="w-full text-sm text-left">
          <thead className="bg-ds-elevated text-ds-ink-muted">
            <tr>
              <th className="px-4 py-2">Bill #</th>
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Subtotal</th>
              <th className="px-4 py-2">GST</th>
              <th className="px-4 py-2">Total</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ds-line/40">
            {list.map((b) => (
              <tr key={b.id} className="hover:bg-ds-elevated/60">
                <td className="px-4 py-2 font-mono text-ds-warning">{b.billNumber}</td>
                <td className="px-4 py-2 text-ds-ink">{b.customer.name}</td>
                <td className="px-4 py-2 text-ds-ink-muted">
                  {new Date(b.billDate).toLocaleDateString()}
                </td>
                <td className="px-4 py-2 text-ds-ink-muted">
                  ₹{b.subtotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2 text-ds-ink-muted">
                  ₹{b.gstAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2 text-ds-ink font-medium">
                  ₹{b.totalAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2">
                  <span className="px-2 py-0.5 rounded text-xs border bg-ds-elevated text-ds-ink border-ds-line/60">
                    {b.status}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Link href={`/billing/${b.id}`} className="text-ds-warning hover:underline">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && (
        <p className="text-ds-ink-faint text-center py-8 text-sm">No bills found.</p>
      )}
    </div>
  )
}
