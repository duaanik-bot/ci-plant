'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type Material = {
  id: string
  materialCode: string
  description: string
  unit: string
  qtyAvailable: number
  qtyReserved: number
  reorderPoint: number
  safetyStock: number
  boardType: string | null
  gsm: number | null
  supplier: { id: string; name: string } | null
  active: boolean
}

function stockHealth(available: number, reorder: number, safety: number): 'green' | 'yellow' | 'red' {
  if (available <= safety) return 'red'
  if (available <= reorder) return 'yellow'
  return 'green'
}

const DOT: Record<string, string> = {
  green: 'bg-green-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
}

export default function MastersMaterialsPage() {
  const [list, setList] = useState<Material[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/masters/materials')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return list
    const q = search.toLowerCase().trim()
    return list.filter((m) => {
      const haystack = [
        m.materialCode,
        m.description,
        m.boardType ?? '',
        m.gsm != null ? String(m.gsm) : '',
        m.unit,
        String(m.qtyAvailable),
        String(m.qtyReserved),
        m.supplier?.name ?? '',
        m.active ? 'active' : 'inactive',
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [list, search])

  if (loading) return <div className="text-slate-400">Loading...</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Board / Paper Master</h2>
        <Link
          href="/masters/materials/new"
          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
        >
          Add material
        </Link>
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code, description, board type, GSM, supplier..."
          className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 text-sm"
        />
      </div>

      <div className="rounded-lg border border-slate-700 overflow-hidden">
        <table className="w-full table-fixed text-xs text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-2 py-2">Stock</th>
              <th className="px-2 py-2">Code</th>
              <th className="px-2 py-2">Description</th>
              <th className="px-2 py-2">Board Type</th>
              <th className="px-2 py-2">GSM</th>
              <th className="px-2 py-2">Unit</th>
              <th className="px-2 py-2">Available</th>
              <th className="px-2 py-2">Reserved</th>
              <th className="px-2 py-2">Supplier</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {filtered.map((m) => {
              const h = stockHealth(m.qtyAvailable, m.reorderPoint, m.safetyStock)
              return (
                <tr key={m.id} className="border-t border-slate-700">
                  <td className="px-2 py-2 align-top">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[h]}`} title={h} />
                  </td>
                  <td className="px-2 py-2 font-mono whitespace-normal break-words align-top">{m.materialCode}</td>
                  <td className="px-2 py-2 whitespace-normal break-words align-top">{m.description}</td>
                  <td className="px-2 py-2 text-slate-400 whitespace-normal break-words align-top">{m.boardType ?? '—'}</td>
                  <td className="px-2 py-2 whitespace-normal break-words align-top">{m.gsm ?? '—'}</td>
                  <td className="px-2 py-2 whitespace-normal break-words align-top">{m.unit}</td>
                  <td className="px-2 py-2 whitespace-normal break-words align-top">{m.qtyAvailable}</td>
                  <td className="px-2 py-2 whitespace-normal break-words align-top">{m.qtyReserved}</td>
                  <td className="px-2 py-2 text-slate-400 whitespace-normal break-words align-top">{m.supplier?.name ?? '—'}</td>
                  <td className="px-2 py-2 align-top">
                    <span className={m.active ? 'text-green-400' : 'text-red-400'}>
                      {m.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-2 py-2 align-top">
                    <Link href={`/masters/materials/${m.id}`} className="text-amber-400 hover:underline">Edit</Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && <p className="text-slate-400 mt-4">No materials match your search.</p>}
    </div>
  )
}
