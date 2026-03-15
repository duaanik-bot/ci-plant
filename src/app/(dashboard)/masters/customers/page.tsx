'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type Customer = {
  id: string
  name: string
  gstNumber: string | null
  contactName: string | null
  contactPhone: string | null
  email: string | null
  address: string | null
  creditLimit: number
  requiresArtworkApproval: boolean
  active: boolean
}

export default function MastersCustomersPage() {
  const [list, setList] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)

  function load() {
    fetch('/api/masters/customers')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load customers'))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  async function deactivate(c: Customer) {
    if (!confirm(`Deactivate ${c.name}?`)) return
    const res = await fetch(`/api/masters/customers/${c.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    })
    if (res.ok) {
      toast.success('Customer deactivated')
      load()
    } else toast.error('Failed')
  }

  if (loading) return <div className="text-slate-400">Loading…</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Customer Master</h2>
        <Link
          href="/masters/customers/new"
          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
        >
          Add customer
        </Link>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">GST</th>
              <th className="px-4 py-2">Contact</th>
              <th className="px-4 py-2">Phone</th>
              <th className="px-4 py-2">Credit Limit</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {list.map((c) => (
              <tr key={c.id} className="border-t border-slate-700">
                <td className="px-4 py-2">{c.name}</td>
                <td className="px-4 py-2 text-slate-400">{c.gstNumber ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400">{c.contactName ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400">{c.contactPhone ?? '—'}</td>
                <td className="px-4 py-2">{c.creditLimit}</td>
                <td className="px-4 py-2">
                  <span className={c.active ? 'text-green-400' : 'text-red-400'}>
                    {c.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Link href={`/masters/customers/${c.id}`} className="text-amber-400 hover:underline mr-2">
                    Edit
                  </Link>
                  {c.active && (
                    <button
                      type="button"
                      onClick={() => deactivate(c)}
                      className="text-slate-400 hover:underline"
                    >
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && (
        <p className="text-slate-400 mt-4">No customers. Add one to get started.</p>
      )}
    </div>
  )
}
