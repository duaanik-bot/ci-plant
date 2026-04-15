'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
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

export default function CartonMasterPage() {
  const [rows, setRows] = useState<CartonRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const cartonsRes = await fetch('/api/masters/cartons')
        const cartonsJson = await cartonsRes.json()
        setRows(Array.isArray(cartonsJson) ? cartonsJson : [])
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
      if (search) {
        const q = search.toLowerCase()
        const size = `${c.finishedLength ?? ''}x${c.finishedWidth ?? ''}x${c.finishedHeight ?? ''}`.toLowerCase()
        const haystack = [
          c.cartonName,
          c.customer?.name || '',
          c.boardGrade || '',
          c.paperType || '',
          String(c.gsm ?? ''),
          size,
          c.active ? 'active' : 'inactive',
          c.rate != null ? String(c.rate) : '',
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [rows, search])

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

      <div className="mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients, board grades, GSM, size, carton..."
          className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 text-sm"
        />
      </div>

      <div className="rounded-lg border border-slate-700 overflow-hidden">
        <table className="w-full table-fixed text-xs text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-2 py-2">Carton</th>
              <th className="px-2 py-2">Client</th>
              <th className="px-2 py-2">L×W×H</th>
              <th className="px-2 py-2">GSM</th>
              <th className="px-2 py-2">Board</th>
              <th className="px-2 py-2">Coating</th>
              <th className="px-2 py-2">Rate</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {filtered.map((c) => (
              <tr key={c.id} className="border-t border-slate-700">
                <td className="px-2 py-2 font-mono whitespace-normal break-words">{c.cartonName}</td>
                <td className="px-2 py-2 text-slate-300 whitespace-normal break-words">{c.customer?.name}</td>
                <td className="px-2 py-2 text-slate-300 whitespace-normal break-words">
                  {c.finishedLength ?? '—'}×{c.finishedWidth ?? '—'}×{c.finishedHeight ?? '—'}
                </td>
                <td className="px-2 py-2 text-slate-300 whitespace-normal break-words">{c.gsm ?? '—'}</td>
                <td className="px-2 py-2 text-slate-300 whitespace-normal break-words">{c.boardGrade ?? '—'}</td>
                <td className="px-2 py-2 text-slate-400 whitespace-normal break-words">—</td>
                <td className="px-2 py-2 text-slate-200 whitespace-normal break-words">
                  {c.rate != null ? `₹${c.rate.toFixed(2)}` : '—'}
                </td>
                <td className="px-2 py-2">
                  <span className={c.active ? 'text-green-400' : 'text-red-400'}>
                    {c.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-2 py-2">
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
        <p className="text-slate-400 mt-4 text-sm">No cartons match your search.</p>
      )}
    </div>
  )
}

