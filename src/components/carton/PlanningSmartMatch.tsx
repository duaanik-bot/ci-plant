'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Match = {
  id: string
  carton_name: string
  client_name: string
  match_score: number
}

export function PlanningSmartMatch() {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  async function search() {
    if (!q.trim()) return
    setLoading(true)
    try {
      const r = await fetch(
        `/api/cartons/smart-search?q=${encodeURIComponent(q)}`,
      )
      const j = await r.json()
      setMatches((j.results ?? []).slice(0, 3))
      setSearched(true)
    } finally {
      setLoading(false)
    }
  }

  const best = matches[0]?.match_score ?? 0
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h3 className="font-semibold text-sm">Planning Smart Match</h3>
      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-2 py-1 text-sm"
          placeholder="Type carton name / scan barcode"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button
          onClick={search}
          disabled={loading}
          className="px-3 py-1 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
        >
          {loading ? '…' : 'Match'}
        </button>
      </div>
      {matches.map((m) => (
        <div key={m.id} className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium">{m.carton_name}</div>
            <div className="text-xs text-muted-foreground">{m.client_name}</div>
            <div className="h-2 bg-muted rounded mt-1">
              <div
                className="h-2 rounded bg-green-500"
                style={{ width: `${m.match_score}%` }}
              />
            </div>
          </div>
          <button
            onClick={() =>
              router.push(`/orders/purchase-orders/new?cartonId=${m.id}`)
            }
            className="text-xs px-2 py-1 rounded border"
          >
            Use this carton
          </button>
        </div>
      ))}
      {searched && best < 40 && (
        <button className="text-xs px-3 py-1 rounded border border-yellow-500 text-yellow-700">
          No match — create new
        </button>
      )}
    </div>
  )
}
