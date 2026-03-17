'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type LineItem = {
  id: string
  cartonName: string
  quantity: number
  rate: number | null
}

type PurchaseOrder = {
  id: string
  poNumber: string
  poDate: string
  customer: { id: string; name: string }
  status: string
  remarks: string | null
  lineItems: LineItem[]
  value: number
}

type Customer = { id: string; name: string }

export default function PurchaseOrdersPage() {
  const [list, setList] = useState<PurchaseOrder[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [customerId, setCustomerId] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const params = new URLSearchParams()
        if (status) params.set('status', status)
        if (customerId) params.set('customerId', customerId)
        const [poRes, custRes] = await Promise.all([
          fetch(`/api/purchase-orders?${params.toString()}`),
          fetch('/api/masters/customers'),
        ])
        const poJson = await poRes.json()
        const custJson = await custRes.json()
        setList(Array.isArray(poJson) ? poJson : [])
        setCustomers(Array.isArray(custJson) ? custJson : [])
      } finally {
        setLoading(false)
      }
    }
    setLoading(true)
    load()
  }, [status, customerId])

  const totalValue = useMemo(
    () => list.reduce((sum, po) => sum + (po.value ?? 0), 0),
    [list]
  )

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-amber-400">Customer Purchase Orders</h1>
        <Link
          href="/orders/purchase-orders/new"
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
        >
          New PO
        </Link>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="confirmed">Confirmed</option>
          <option value="closed">Closed</option>
        </select>
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
        <div className="ml-auto text-sm text-slate-300">
          Total value:{' '}
          <span className="font-semibold text-amber-300">
            ₹{totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-left">
            <tr>
              <th className="px-4 py-2">PO #</th>
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Lines</th>
              <th className="px-4 py-2">Value</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {list.map((po) => (
              <tr key={po.id} className="hover:bg-slate-800/60">
                <td className="px-4 py-2 font-mono text-amber-300">{po.poNumber}</td>
                <td className="px-4 py-2 text-slate-200">{po.customer?.name}</td>
                <td className="px-4 py-2 text-slate-300">
                  {new Date(po.poDate).toLocaleDateString()}
                </td>
                <td className="px-4 py-2 text-slate-300">{po.lineItems.length}</td>
                <td className="px-4 py-2 text-slate-200">
                  ₹{(po.value ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`px-2 py-0.5 rounded text-xs border ${
                      po.status === 'confirmed'
                        ? 'bg-green-900/40 text-green-300 border-green-600'
                        : po.status === 'closed'
                        ? 'bg-slate-800 text-slate-300 border-slate-500'
                        : 'bg-amber-900/40 text-amber-200 border-amber-600'
                    }`}
                  >
                    {po.status}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Link
                    href={`/orders/purchase-orders/${po.id}`}
                    className="text-amber-400 hover:underline"
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">No purchase orders found.</p>
      )}
    </div>
  )
}

