'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PAPER_TYPES, BOARD_GRADES, CARTON_CONSTRUCTIONS } from '@/lib/constants'
import { toast } from 'sonner'

type CartonRow = {
  id: string
  cartonName: string
  customerId: string
  customer: { id: string; name: string }
  gsm: number | null
  boardGrade: string | null
  paperType: string | null
  finishedLength: number | null
  finishedWidth: number | null
  finishedHeight: number | null
  rate: number | null
  active: boolean
}

type Customer = { id: string; name: string }

export default function CartonMasterPage() {
  const [rows, setRows] = useState<CartonRow[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [filterClient, setFilterClient] = useState('')
  const [search, setSearch] = useState('')
  const [filterBoard, setFilterBoard] = useState('')
  const [filterPaper, setFilterPaper] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const [cartonsRes, custRes] = await Promise.all([
          fetch('/api/masters/cartons'),
          fetch('/api/masters/customers'),
        ])
        const cartonsJson = await cartonsRes.json()
        const custJson = await custRes.json()
        setRows(Array.isArray(cartonsJson) ? cartonsJson : [])
        setCustomers(Array.isArray(custJson) ? custJson : [])
      } catch {
        toast.error('Failed to load cartons')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const filtered = useMemo(() => {
    return rows.filter((c) => {
      if (filterClient && c.customerId !== filterClient) return false
      if (filterBoard && c.boardGrade !== filterBoard) return false
      if (filterPaper && c.paperType !== filterPaper) return false
      if (search) {
        const q = search.toLowerCase()
        if (
          !c.cartonName.toLowerCase().includes(q) &&
          !c.customer.name.toLowerCase().includes(q)
        ) {
          return false
        }
      }
      return true
    })
  }, [rows, filterClient, filterBoard, filterPaper, search])

  if (loading) return <div className="text-slate-400">Loading cartons…</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Carton Master</h2>
        <Link
          href="/masters/cartons/new"
          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
        >
          Add carton
        </Link>
      </div>

      <div className="flex flex-wrap gap-3 mb-3 text-sm">
        <select
          value={filterClient}
          onChange={(e) => setFilterClient(e.target.value)}
          className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-100"
        >
          <option value="">All clients</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={filterBoard}
          onChange={(e) => setFilterBoard(e.target.value)}
          className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-100"
        >
          <option value="">All board grades</option>
          {BOARD_GRADES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select
          value={filterPaper}
          onChange={(e) => setFilterPaper(e.target.value)}
          className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-100"
        >
          <option value="">All paper types</option>
          {PAPER_TYPES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search carton or client…"
          className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-100"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Carton</th>
              <th className="px-4 py-2">Client</th>
              <th className="px-4 py-2">Size (L×W×H)</th>
              <th className="px-4 py-2">GSM</th>
              <th className="px-4 py-2">Board</th>
              <th className="px-4 py-2">Coating</th>
              <th className="px-4 py-2">Rate</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {filtered.map((c) => (
              <tr key={c.id} className="border-t border-slate-700">
                <td className="px-4 py-2 font-mono">{c.cartonName}</td>
                <td className="px-4 py-2 text-slate-300">{c.customer?.name}</td>
                <td className="px-4 py-2 text-slate-300">
                  {c.finishedLength ?? '—'}×{c.finishedWidth ?? '—'}×{c.finishedHeight ?? '—'}
                </td>
                <td className="px-4 py-2 text-slate-300">{c.gsm ?? '—'}</td>
                <td className="px-4 py-2 text-slate-300">{c.boardGrade ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400">—</td>
                <td className="px-4 py-2 text-slate-200">
                  {c.rate != null ? `₹${c.rate.toFixed(2)}` : '—'}
                </td>
                <td className="px-4 py-2">
                  <span className={c.active ? 'text-green-400' : 'text-red-400'}>
                    {c.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Link
                    href={`/masters/cartons/${c.id}`}
                    className="text-amber-400 hover:underline"
                  >
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && (
        <p className="text-slate-400 mt-4 text-sm">No cartons match the current filters.</p>
      )}
    </div>
  )
}

