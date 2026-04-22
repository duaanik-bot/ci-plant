'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type Die = {
  id: string
  dieCode: string
  dieNumber: number | null
  dieType: string
  status: string
  condition: string
  compartment: string | null
  cartonName: string | null
}

export default function DieLocationViewPage() {
  const [data, setData] = useState<Record<string, Die[]>>({})
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch(`/api/die-store/location-view?search=${encodeURIComponent(search)}`)
      .then((r) => r.json())
      .then((json) => setData(json || {}))
  }, [search])

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ds-warning">Die Location View</h1>
        <Link href="/masters/dies" className="px-3 py-2 rounded-lg border border-ds-line/60 text-ds-ink text-sm">Back</Link>
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search die or carton" className="w-full md:w-96 px-3 py-2 rounded bg-ds-elevated border border-ds-line/60 text-foreground text-sm" />
      <div className="space-y-4">
        {Object.entries(data).map(([rack, dies]) => (
          <div key={rack} className="rounded-xl border border-ds-line/50 bg-ds-card p-3">
            <div className="flex justify-between"><h2 className="text-sm font-semibold text-ds-ink">{rack}</h2><span className="text-xs text-ds-ink-faint">{dies.length}/8 occupied</span></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
              {Array.from({ length: 8 }, (_, i) => {
                const compartment = `Compartment ${i + 1}`
                const die = dies.find((d) => (d.compartment || '').toLowerCase() === compartment.toLowerCase())
                if (!die) return <div key={compartment} className="rounded border border-ds-line/40 bg-ds-elevated/50 p-2 text-xs text-ds-ink-faint">EMPTY<br />{compartment}</div>
                return (
                  <Link key={compartment} href={`/masters/dies/${die.id}`} className="rounded border border-ds-line/50 bg-ds-elevated p-2 text-xs">
                    <p className="font-mono text-ds-warning">{die.dieCode}</p>
                    <p className="text-ds-ink-muted">No. {die.dieNumber ?? '-'}</p>
                    <p className="text-ds-ink-muted">{die.dieType}</p>
                    <p className="text-ds-ink-faint">{die.condition}</p>
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
