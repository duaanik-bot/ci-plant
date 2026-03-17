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

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-amber-400">Billing</h1>
        <Link
          href="/billing/new"
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
        >
          New bill
        </Link>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white min-w-[180px]"
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
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="paid">Paid</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
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
          <tbody className="divide-y divide-slate-700">
            {list.map((b) => (
              <tr key={b.id} className="hover:bg-slate-800/60">
                <td className="px-4 py-2 font-mono text-amber-300">{b.billNumber}</td>
                <td className="px-4 py-2 text-slate-200">{b.customer.name}</td>
                <td className="px-4 py-2 text-slate-300">
                  {new Date(b.billDate).toLocaleDateString()}
                </td>
                <td className="px-4 py-2 text-slate-300">
                  ₹{b.subtotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2 text-slate-300">
                  ₹{b.gstAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2 text-slate-200 font-medium">
                  ₹{b.totalAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2">
                  <span className="px-2 py-0.5 rounded text-xs border bg-slate-800 text-slate-200 border-slate-600">
                    {b.status}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Link href={`/billing/${b.id}`} className="text-amber-400 hover:underline">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">No bills found.</p>
      )}
    </div>
  )
}
