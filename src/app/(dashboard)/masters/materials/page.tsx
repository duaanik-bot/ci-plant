'use client'

import { useState, useEffect } from 'react'
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
  supplier: { id: string; name: string } | null
  active: boolean
}

export default function MastersMaterialsPage() {
  const [list, setList] = useState<Material[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/masters/materials')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-slate-400">Loading…</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Material / Item Master</h2>
        <Link
          href="/masters/materials/new"
          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
        >
          Add material
        </Link>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Description</th>
              <th className="px-4 py-2">Unit</th>
              <th className="px-4 py-2">Available</th>
              <th className="px-4 py-2">Reserved</th>
              <th className="px-4 py-2">Reorder</th>
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {list.map((m) => (
              <tr key={m.id} className="border-t border-slate-700">
                <td className="px-4 py-2 font-mono">{m.materialCode}</td>
                <td className="px-4 py-2">{m.description}</td>
                <td className="px-4 py-2">{m.unit}</td>
                <td className="px-4 py-2">{m.qtyAvailable}</td>
                <td className="px-4 py-2">{m.qtyReserved}</td>
                <td className="px-4 py-2">{m.reorderPoint}</td>
                <td className="px-4 py-2 text-slate-400">{m.supplier?.name ?? '—'}</td>
                <td className="px-4 py-2">
                  <span className={m.active ? 'text-green-400' : 'text-red-400'}>
                    {m.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Link href={`/masters/materials/${m.id}`} className="text-amber-400 hover:underline">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p className="text-slate-400 mt-4">No materials.</p>}
    </div>
  )
}
