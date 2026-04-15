'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
type DyeRow = {
  id: string
  dyeNumber: number
  dyeType: string
  ups: number
  sheetSize: string
  cartonSize: string
  location: string | null
  impressionCount: number
  conditionRating: string | null
  active: boolean
}

export default function DyeMasterPage() {
  const [rows, setRows] = useState<DyeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/masters/dyes')
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load dyes'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter(
      (d) =>
        String(d.dyeNumber).includes(q) ||
        d.dyeType.toLowerCase().includes(q) ||
        d.cartonSize.toLowerCase().includes(q)
    )
  }, [rows, search])

  if (loading) return <div className="text-slate-400">Loading dyes…</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Dye Master</h2>
        <Link
          href="/masters/dyes/new"
          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
        >
          Add dye
        </Link>
      </div>

      <div className="flex gap-3 mb-3 text-sm">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by dye no, type, size…"
          className="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-100"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Dye No.</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">UPS</th>
              <th className="px-4 py-2">Sheet Size</th>
              <th className="px-4 py-2">Carton Size</th>
              <th className="px-4 py-2">Impressions</th>
              <th className="px-4 py-2">Condition</th>
              <th className="px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {filtered.map((d) => (
                <tr key={d.id} className="border-t border-slate-700">
                  <td className="px-4 py-2 font-mono">{d.dyeNumber}</td>
                  <td className="px-4 py-2 text-slate-300">{d.dyeType}</td>
                  <td className="px-4 py-2 text-slate-300">{d.ups}</td>
                  <td className="px-4 py-2 text-slate-300">{d.sheetSize}</td>
                  <td className="px-4 py-2 text-slate-300">{d.cartonSize}</td>
                  <td className="px-4 py-2 text-slate-300">
                    {d.impressionCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-slate-300">
                    {d.conditionRating ?? 'Good'}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/masters/dyes/${d.id}`}
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
        <p className="text-slate-400 mt-4 text-sm">No dyes found.</p>
      )}
    </div>
  )
}

