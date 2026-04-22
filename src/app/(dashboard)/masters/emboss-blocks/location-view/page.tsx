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
        <h1 className="text-xl font-bold text-ds-warning">Block Location View</h1>
        <Link href="/masters/emboss-blocks" className="px-3 py-2 rounded border border-ds-line/60 text-ds-ink text-sm">Back</Link>
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search block or carton" className="w-full md:w-96 px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground text-sm" />

      <div className="space-y-4">
        {Object.entries(data).map(([rack, blocks]) => (
          <div key={rack} className="rounded-xl border border-ds-line/50 bg-ds-card p-3">
            <div className="flex justify-between"><h2 className="text-sm font-semibold text-ds-ink">{rack}</h2><span className="text-xs text-ds-ink-faint">{blocks.length}/6 used</span></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
              {Array.from({ length: 6 }, (_, i) => {
                const shelf = `Shelf ${i + 1}`
                const block = blocks.find((b) => (b.compartment || '').toLowerCase() === shelf.toLowerCase())
                if (!block) return <div key={shelf} className="rounded border border-ds-line/40 bg-ds-elevated/50 p-2 text-xs text-ds-ink-faint">EMPTY<br />{shelf}</div>
                return (
                  <Link key={shelf} href={`/masters/emboss-blocks/${block.id}`} className="rounded border border-ds-line/50 bg-ds-elevated p-2 text-xs">
                    <p className="font-mono text-ds-warning">{block.blockCode}</p>
                    <p className="text-ds-ink-muted">No. {block.blockNumber ?? '-'}</p>
                    <p className="text-ds-ink-muted">{block.blockType}</p>
                    <p className="text-ds-ink-faint">{block.condition}</p>
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

