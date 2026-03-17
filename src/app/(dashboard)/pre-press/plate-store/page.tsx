'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type PlateRow = {
  id: string
  plateSetCode: string
  cartonName: string
  customerId: string | null
  customer: { id: string; name: string } | null
  artworkVersion: string | null
  numberOfColours: number
  colours: Record<string, string>
  newPlates: number
  oldPlates: number
  storageLocation: string | null
  ctpDate: string | null
  collectedAt: string | null
  status: string
  createdAt: string
}

type Customer = { id: string; name: string }

const STATUS_BADGE: Record<string, string> = {
  in_use: 'bg-blue-900/50 text-blue-200 border-blue-600',
  stored: 'bg-green-900/50 text-green-200 border-green-600',
  destroyed: 'bg-red-900/50 text-red-200 border-red-600',
  missing: 'bg-amber-900/50 text-amber-200 border-amber-600',
}

export default function PlateStoreListPage() {
  const [list, setList] = useState<PlateRow[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [customerId, setCustomerId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [plateRes, custRes] = await Promise.all([
          fetch(`/api/plate-store?${new URLSearchParams({ customerId, status, ...(search.trim() ? { q: search.trim() } : {}) })}`),
          fetch('/api/masters/customers'),
        ])
        const plateJson = await plateRes.json()
        const custJson = await custRes.json()
        if (!cancelled) {
          setList(Array.isArray(plateJson) ? plateJson : [])
          setCustomers(Array.isArray(custJson) ? custJson : [])
        }
      } catch {
        if (!cancelled) toast.error('Failed to load plate store')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [customerId, status, search])

  if (loading && list.length === 0) {
    return (
      <div className="p-4 max-w-6xl mx-auto">
        <div className="h-8 w-48 bg-slate-800 rounded animate-pulse mb-4" />
        <div className="h-64 bg-slate-800/50 rounded animate-pulse" />
      </div>
    )
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-amber-400">Plate Store</h1>
        <Link
          href="/pre-press/plate-store/new"
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
        >
          Add plate record
        </Link>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
        <label className="block text-xs text-slate-400 mb-1">Search by carton name or artwork code</label>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Type to search…"
          className="w-full max-w-md px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white placeholder-slate-500"
        />
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white min-w-[180px]"
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
        >
          <option value="">All statuses</option>
          <option value="in_use">In use</option>
          <option value="stored">Stored</option>
          <option value="destroyed">Destroyed</option>
          <option value="missing">Missing</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-3 py-2">Plate set</th>
              <th className="px-3 py-2">Carton</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Artwork ver.</th>
              <th className="px-3 py-2">Colours</th>
              <th className="px-3 py-2">New / Old</th>
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2">CTP date</th>
              <th className="px-3 py-2">Last used</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {list.map((p) => (
              <tr key={p.id} className="hover:bg-slate-800/60">
                <td className="px-3 py-2 font-mono text-amber-300">{p.plateSetCode}</td>
                <td className="px-3 py-2 text-slate-200">{p.cartonName}</td>
                <td className="px-3 py-2 text-slate-200">{p.customer?.name ?? '—'}</td>
                <td className="px-3 py-2 text-slate-200">{p.artworkVersion ?? '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-0.5">
                    {Object.entries((p.colours as Record<string, string>) ?? {}).map(([name, st]) => (
                      <span
                        key={name}
                        className={`px-1.5 py-0.5 rounded text-xs ${
                          st === 'destroyed' ? 'bg-red-900/50 text-red-300' : st === 'new' ? 'bg-green-900/50 text-green-300' : 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-slate-200">{p.newPlates} / {p.oldPlates}</td>
                <td className="px-3 py-2 text-slate-400">{p.storageLocation ?? '—'}</td>
                <td className="px-3 py-2 text-slate-400">
                  {p.ctpDate ? new Date(p.ctpDate).toLocaleDateString('en-IN') : '—'}
                </td>
                <td className="px-3 py-2 text-slate-400">
                  {p.collectedAt ? new Date(p.collectedAt).toLocaleDateString('en-IN') : '—'}
                </td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs border ${STATUS_BADGE[p.status] ?? 'bg-slate-700 text-slate-300 border-slate-600'}`}>
                    {p.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={`/pre-press/plate-store/${p.id}`}
                    className="text-amber-400 hover:underline text-xs"
                  >
                    View details
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && !loading && (
        <p className="text-slate-500 text-center py-8 text-sm">No plate records found.</p>
      )}
    </div>
  )
}
