'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type BlockRow = {
  id: string
  blockCode: string
  cartonName: string | null
  blockType: string
  blockMaterial: string
  blockSize: string | null
  storageLocation: string | null
  impressionCount: number
  maxImpressions: number
  condition: string
  active: boolean
}

export default function EmbossBlocksListPage() {
  const [rows, setRows] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams()
    if (search.trim()) params.set('q', search.trim())
    if (showInactive) params.set('active', 'false')
    fetch(`/api/masters/emboss-blocks?${params}`)
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load emboss blocks'))
      .finally(() => setLoading(false))
  }, [search, showInactive])

  if (loading) return <div className="text-slate-400">Loading emboss blocks…</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Emboss Blocks</h2>
        <Link
          href="/masters/emboss-blocks/new"
          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
        >
          Add block
        </Link>
      </div>

      <div className="flex flex-wrap gap-3 mb-3 text-sm">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by block code or carton name…"
          className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-slate-100"
        />
        <label className="flex items-center gap-2 text-slate-300">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded border-slate-600"
          />
          Show inactive
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Block code</th>
              <th className="px-4 py-2">Carton</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Material</th>
              <th className="px-4 py-2">Impressions</th>
              <th className="px-4 py-2">Condition</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {rows.map((b) => {
              const lifePct =
                b.maxImpressions > 0
                  ? Math.min(100, Math.round((b.impressionCount / b.maxImpressions) * 100))
                  : 0
              let barColor = 'bg-green-500'
              if (lifePct >= 80) barColor = 'bg-red-500'
              else if (lifePct >= 50) barColor = 'bg-amber-500'

              return (
                <tr key={b.id} className="border-t border-slate-700">
                  <td className="px-4 py-2 font-mono">{b.blockCode}</td>
                  <td className="px-4 py-2 text-slate-300">{b.cartonName ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-300">{b.blockType}</td>
                  <td className="px-4 py-2 text-slate-300">{b.blockMaterial}</td>
                  <td className="px-4 py-2">
                    <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full ${barColor}`}
                        style={{ width: `${lifePct}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-400">
                      {b.impressionCount.toLocaleString()} / {b.maxImpressions.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-300">{b.condition}</td>
                  <td className="px-4 py-2">
                    {b.active ? (
                      <span className="text-green-400">Active</span>
                    ) : (
                      <span className="text-slate-500">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/masters/emboss-blocks/${b.id}`}
                      className="text-amber-400 hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p className="text-slate-400 mt-4 text-sm">No emboss blocks found.</p>
      )}
    </div>
  )
}
