'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'

type Customer = { id: string; name: string }
type CartonOption = { id: string; cartonName: string; customerId?: string }

export default function NewPlateStorePage() {
  const router = useRouter()
  const [cartonName, setCartonName] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [cartonId, setCartonId] = useState('')
  const [artworkCode, setArtworkCode] = useState('')
  const [artworkVersion, setArtworkVersion] = useState('')
  const [numberOfColours, setNumberOfColours] = useState(2)
  const [colourRows, setColourRows] = useState<{ name: string; status: 'new' | 'old' | 'destroyed' }[]>([
    { name: 'C', status: 'new' },
    { name: 'M', status: 'new' },
  ])
  const [rackLocation, setRackLocation] = useState('')
  const [slotNumber, setSlotNumber] = useState('')
  const [ctpOperator, setCtpOperator] = useState('')
  const [ctpDate, setCtpDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [users, setUsers] = useState<{ id: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)

  const cartonSearch = useAutoPopulate<CartonOption>({
    storageKey: 'plate-store-carton',
    search: async (query: string) => {
      const res = await fetch(`/api/cartons?q=${encodeURIComponent(query)}`)
      return res.json()
    },
    getId: (c) => c.id,
    getLabel: (c) => c.cartonName,
  })

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((data) => setUsers(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const n = Math.max(1, Math.min(6, numberOfColours))
    setColourRows((prev) => {
      if (prev.length === n) return prev
      if (prev.length < n) {
        const names = ['C', 'M', 'Y', 'K', 'P1', 'P2']
        return [
          ...prev,
          ...Array.from({ length: n - prev.length }, (_, i) => ({
            name: names[prev.length + i] ?? `P${prev.length + i + 1}`,
            status: 'new' as const,
          })),
        ]
      }
      return prev.slice(0, n)
    })
  }, [numberOfColours])

  const applyCarton = (c: CartonOption) => {
    cartonSearch.select(c)
    setCartonName(c.cartonName)
    setCartonId(c.id)
    if (c.customerId) setCustomerId(c.customerId)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!cartonName.trim()) {
      toast.error('Carton name is required')
      return
    }
    const colours = colourRows.map((r, idx) => ({
      name: r.name.trim() || `Colour${idx + 1}`,
      type: ['C', 'M', 'Y', 'K'].includes(r.name.toUpperCase()) ? 'process' : 'pantone',
      status: r.status,
      rackLocation: rackLocation.trim() || null,
      slotNumber: slotNumber.trim() || null,
      condition: r.status === 'destroyed' ? 'Destroyed' : r.status === 'new' ? 'New' : 'Good',
    }))
    setSaving(true)
    try {
      const res = await fetch('/api/plate-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartonName: cartonName.trim(),
          customerId: customerId || null,
          cartonId: cartonId || null,
          artworkCode: artworkCode.trim() || null,
          artworkVersion: artworkVersion.trim() || null,
          numberOfColours: colourRows.length,
          colours,
          rackLocation: rackLocation.trim() || null,
          slotNumber: slotNumber.trim() || null,
          ctpOperator: ctpOperator.trim() || null,
          ctpDate: ctpDate || null,
          ctpJobReference: notes.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create')
      toast.success(`Plate set ${data.plateSetCode} created`)
      router.push('/pre-press/plate-store')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <Link href="/pre-press/plate-store" className="text-slate-400 hover:text-foreground text-sm mb-4 inline-block">
        ← Plate store
      </Link>
      <h1 className="text-xl font-bold text-amber-400 mb-4">Add plate record</h1>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-xl bg-slate-900 border border-slate-700 p-4">
        <div>
          <MasterSearchSelect
            label="Carton name"
            required
            query={cartonSearch.query || cartonName}
            onQueryChange={(value) => {
              cartonSearch.setQuery(value)
              setCartonName(value)
              setCartonId('')
            }}
            loading={cartonSearch.loading}
            options={cartonSearch.options}
            lastUsed={cartonSearch.lastUsed}
            onSelect={applyCarton}
            getOptionLabel={(c) => c.cartonName}
            placeholder="Type carton name..."
            recentLabel="Recent cartons"
            loadingMessage="Searching cartons..."
            emptyMessage="No carton found."
          />
        </div>

        <div>
          <label className="block text-slate-400 mb-1">Artwork code</label>
          <input
            type="text"
            value={artworkCode}
            onChange={(e) => setArtworkCode(e.target.value)}
            placeholder="e.g. BSJ.2.5CT-0325"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>

        <div>
          <label className="block text-slate-400 mb-1">Artwork version (e.g. R0, R1)</label>
          <input
            type="text"
            value={artworkVersion}
            onChange={(e) => setArtworkVersion(e.target.value)}
            placeholder="R0 / R1 / R2…"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>

        <div>
          <label className="block text-slate-400 mb-1">Number of colours (1–6) *</label>
          <input
            type="number"
            min={1}
            max={6}
            value={numberOfColours}
            onChange={(e) => setNumberOfColours(Number(e.target.value) || 1)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>

        <div>
          <label className="block text-slate-400 mb-2">Per colour</label>
          <div className="space-y-2">
            {colourRows.map((row, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) =>
                    setColourRows((prev) =>
                      prev.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r))
                    )
                  }
                  placeholder="C / M / Y / K / Pantone"
                  className="w-24 px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-foreground text-sm"
                />
                <select
                  value={row.status}
                  onChange={(e) =>
                    setColourRows((prev) =>
                      prev.map((r, i) =>
                        i === idx ? { ...r, status: e.target.value as 'new' | 'old' | 'destroyed' } : r
                      )
                    )
                  }
                  className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-foreground text-sm"
                >
                  <option value="new">New</option>
                  <option value="old">Old</option>
                  <option value="destroyed">Destroyed</option>
                </select>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-slate-400 mb-1">Rack location</label>
          <input
            type="text"
            value={rackLocation}
            onChange={(e) => setRackLocation(e.target.value)}
            placeholder="e.g. Rack B-3"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>

        <div>
          <label className="block text-slate-400 mb-1">Slot number</label>
          <input
            type="text"
            value={slotNumber}
            onChange={(e) => setSlotNumber(e.target.value)}
            placeholder="e.g. Slot 12"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>

        <div>
          <label className="block text-slate-400 mb-1">CTP operator</label>
          <select
            value={ctpOperator}
            onChange={(e) => setCtpOperator(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          >
            <option value="">Select…</option>
            {users.map((u) => (
              <option key={u.id} value={u.name}>{u.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-slate-400 mb-1">CTP date</label>
          <input
            type="date"
            value={ctpDate}
            onChange={(e) => setCtpDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>

        <div>
          <label className="block text-slate-400 mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={() => router.push('/pre-press/plate-store')}
            className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-primary-foreground text-sm font-medium"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
