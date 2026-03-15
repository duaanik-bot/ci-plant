'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type Supplier = {
  id: string
  name: string
  gstNumber: string | null
  contactName: string | null
  contactPhone: string | null
  materialTypes: string[]
  leadTimeDays: number
  active: boolean
}

const MATERIAL_OPTIONS = ['Paperboard', 'Inks', 'Foil', 'UV Varnish', 'Laminate Film', 'Consumables', 'Plates']

export default function MastersSuppliersPage() {
  const [list, setList] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/masters/suppliers')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-slate-400">Loading…</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Supplier Master</h2>
        <Link
          href="/masters/suppliers/new"
          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
        >
          Add supplier
        </Link>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">GST</th>
              <th className="px-4 py-2">Contact</th>
              <th className="px-4 py-2">Material types</th>
              <th className="px-4 py-2">Lead time</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {list.map((s) => (
              <tr key={s.id} className="border-t border-slate-700">
                <td className="px-4 py-2">{s.name}</td>
                <td className="px-4 py-2 text-slate-400">{s.gstNumber ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400">{s.contactName ?? '—'}</td>
                <td className="px-4 py-2">
                  {s.materialTypes.length
                    ? s.materialTypes.map((t) => (
                        <span key={t} className="mr-1 px-1.5 py-0.5 rounded bg-slate-700 text-xs">
                          {t}
                        </span>
                      ))
                    : '—'}
                </td>
                <td className="px-4 py-2">{s.leadTimeDays} days</td>
                <td className="px-4 py-2">
                  <span className={s.active ? 'text-green-400' : 'text-red-400'}>
                    {s.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Link href={`/masters/suppliers/${s.id}`} className="text-amber-400 hover:underline">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p className="text-slate-400 mt-4">No suppliers.</p>}
    </div>
  )
}
