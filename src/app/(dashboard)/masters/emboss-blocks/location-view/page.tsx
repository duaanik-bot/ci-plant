'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type Block = {
  id: string
  blockCode: string
  blockNumber: number | null
  blockType: string
  condition: string
  compartment: string | null
  cartonName: string | null
}

export default function EmbossLocationViewPage() {
  const [data, setData] = useState<Record<string, Block[]>>({})
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch(`/api/emboss-blocks/location-view?search=${encodeURIComponent(search)}`)
      .then((r) => r.json())
      .then((json) => setData(json || {}))
  }, [search])

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-amber-400">Block Location View</h1>
        <Link href="/masters/emboss-blocks" className="px-3 py-2 rounded border border-slate-600 text-slate-200 text-sm">Back</Link>
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search block or carton" className="w-full md:w-96 px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />

      <div className="space-y-4">
        {Object.entries(data).map(([rack, blocks]) => (
          <div key={rack} className="rounded-xl border border-slate-700 bg-slate-900 p-3">
            <div className="flex justify-between"><h2 className="text-sm font-semibold text-slate-200">{rack}</h2><span className="text-xs text-slate-500">{blocks.length}/6 used</span></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
              {Array.from({ length: 6 }, (_, i) => {
                const shelf = `Shelf ${i + 1}`
                const block = blocks.find((b) => (b.compartment || '').toLowerCase() === shelf.toLowerCase())
                if (!block) return <div key={shelf} className="rounded border border-slate-800 bg-slate-800/50 p-2 text-xs text-slate-500">EMPTY<br />{shelf}</div>
                return (
                  <Link key={shelf} href={`/masters/emboss-blocks/${block.id}`} className="rounded border border-slate-700 bg-slate-800 p-2 text-xs">
                    <p className="font-mono text-amber-300">{block.blockCode}</p>
                    <p className="text-slate-300">No. {block.blockNumber ?? '-'}</p>
                    <p className="text-slate-400">{block.blockType}</p>
                    <p className="text-slate-500">{block.condition}</p>
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

