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
        <h1 className="text-xl font-bold text-amber-400">Die Location View</h1>
        <Link href="/masters/dies" className="px-3 py-2 rounded-lg border border-slate-600 text-slate-200 text-sm">Back</Link>
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search die or carton" className="w-full md:w-96 px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
      <div className="space-y-4">
        {Object.entries(data).map(([rack, dies]) => (
          <div key={rack} className="rounded-xl border border-slate-700 bg-slate-900 p-3">
            <div className="flex justify-between"><h2 className="text-sm font-semibold text-slate-200">{rack}</h2><span className="text-xs text-slate-500">{dies.length}/8 occupied</span></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
              {Array.from({ length: 8 }, (_, i) => {
                const compartment = `Compartment ${i + 1}`
                const die = dies.find((d) => (d.compartment || '').toLowerCase() === compartment.toLowerCase())
                if (!die) return <div key={compartment} className="rounded border border-slate-800 bg-slate-800/50 p-2 text-xs text-slate-500">EMPTY<br />{compartment}</div>
                return (
                  <Link key={compartment} href={`/masters/dies/${die.id}`} className="rounded border border-slate-700 bg-slate-800 p-2 text-xs">
                    <p className="font-mono text-amber-300">{die.dieCode}</p>
                    <p className="text-slate-300">No. {die.dieNumber ?? '-'}</p>
                    <p className="text-slate-400">{die.dieType}</p>
                    <p className="text-slate-500">{die.condition}</p>
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
