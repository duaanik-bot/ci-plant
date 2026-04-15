'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

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
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

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

  useEffect(() => {
    setLoading(true)
    load()
  }, [status, customerId])

  async function handleDelete(po: PurchaseOrder) {
    if (!confirm(`Delete PO ${po.poNumber}? This cannot be undone.`)) return
    setDeletingId(po.id)
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as any).error || 'Failed to delete')
      toast.success(`${po.poNumber} deleted`)
      setList((prev) => prev.filter((p) => p.id !== po.id))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleConfirm(po: PurchaseOrder) {
    if (!confirm(`Confirm PO ${po.poNumber}? All line items will be pushed to the Artwork queue.`)) return
    setConfirmingId(po.id)
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as any).error || 'Failed to confirm')
      toast.success(`${po.poNumber} confirmed — ${po.lineItems.length} item(s) pushed to Artwork queue`)
      setList((prev) => prev.map((p) => p.id === po.id ? { ...p, status: 'confirmed' } : p))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to confirm')
    } finally {
      setConfirmingId(null)
    }
  }

  async function handleStatusChange(po: PurchaseOrder, newStatus: string) {
    if (newStatus === po.status) return
    setUpdatingId(po.id)
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as any).error || 'Failed to update status')
      toast.success(`Status updated to ${newStatus}`)
      setList((prev) => prev.map((p) => p.id === po.id ? { ...p, status: newStatus } : p))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setUpdatingId(null)
    }
  }

  const totalValue = useMemo(
    () => list.reduce((sum, po) => sum + (po.value ?? 0), 0),
    [list]
  )

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-amber-400">Customer Purchase Orders</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/orders/designing"
            className="px-3 py-2 rounded-lg border border-slate-600 text-slate-200 text-sm"
          >
            Next: Prepress Queue →
          </Link>
          <Link
            href="/orders/purchase-orders/new"
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
          >
            New PO
          </Link>
        </div>
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
                  <select
                    value={po.status}
                    disabled={updatingId === po.id}
                    onChange={(e) => handleStatusChange(po, e.target.value)}
                    className={`px-2 py-0.5 rounded text-xs border bg-transparent cursor-pointer disabled:opacity-50 ${
                      po.status === 'confirmed'
                        ? 'text-green-300 border-green-600'
                        : po.status === 'closed'
                        ? 'text-slate-300 border-slate-500'
                        : 'text-amber-200 border-amber-600'
                    }`}
                  >
                    <option value="draft">draft</option>
                    <option value="confirmed">confirmed</option>
                    <option value="closed">closed</option>
                  </select>
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    {po.status === 'draft' && (
                      <button
                        type="button"
                        onClick={() => handleConfirm(po)}
                        disabled={confirmingId === po.id}
                        className="px-2 py-0.5 rounded text-xs font-medium bg-green-700 hover:bg-green-600 text-white disabled:opacity-40"
                      >
                        {confirmingId === po.id ? 'Confirming…' : 'Confirm →'}
                      </button>
                    )}
                    <Link
                      href={`/orders/purchase-orders/${po.id}`}
                      className="text-amber-400 hover:underline text-xs font-medium"
                    >
                      Edit
                    </Link>
                    <button
                      type="button"
                      onClick={() => handleDelete(po)}
                      disabled={deletingId === po.id}
                      className="text-red-400 hover:text-red-300 text-xs font-medium disabled:opacity-40"
                    >
                      {deletingId === po.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
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

