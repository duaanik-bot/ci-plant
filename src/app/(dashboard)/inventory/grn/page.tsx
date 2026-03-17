'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'

type InventoryItem = { id: string; materialCode: string; description: string; unit: string }

export default function GrnPage() {
  const router = useRouter()
  const [materialId, setMaterialId] = useState('')
  const [qty, setQty] = useState('')
  const [lotNumber, setLotNumber] = useState('')
  const [costPerUnit, setCostPerUnit] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const materialSearch = useAutoPopulate<InventoryItem>({
    storageKey: 'grn-material',
    search: async (query: string) => {
      const res = await fetch('/api/inventory')
      const data = (await res.json()) as InventoryItem[]
      const q = query.toLowerCase()
      return data.filter(
        (m) =>
          m.materialCode.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q),
      )
    },
    getId: (m) => m.id,
    getLabel: (m) => `${m.materialCode} — ${m.description}`,
  })

  const applyMaterial = (m: InventoryItem) => {
    materialSearch.select(m)
    setMaterialId(m.id)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!materialId || !qty || Number(qty) <= 0) {
      toast.error('Select material and enter qty')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/inventory/grn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialId,
          qty: Number(qty),
          lotNumber: lotNumber || undefined,
          costPerUnit: costPerUnit ? Number(costPerUnit) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      toast.success(data.message)
      router.push('/inventory')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-4 max-w-md mx-auto">
      <Link href="/inventory" className="text-slate-400 hover:text-white text-sm mb-4 inline-block">← Inventory</Link>
      <h1 className="text-xl font-bold text-amber-400 mb-4">Goods receipt (GRN)</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Material *</label>
          <input
            type="text"
            value={materialSearch.query}
            onChange={(e) => {
              materialSearch.setQuery(e.target.value)
              setMaterialId('')
            }}
            placeholder="Code or description…"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
          {materialSearch.loading && (
            <p className="text-xs text-slate-400 mt-0.5">Searching…</p>
          )}
          {materialSearch.options.length > 0 && (
            <div className="mt-0.5 rounded border border-slate-700 bg-slate-900 max-h-40 overflow-y-auto">
              {materialSearch.options.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => applyMaterial(m)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 text-slate-100"
                >
                  {m.materialCode} — {m.description}
                </button>
              ))}
            </div>
          )}
          {materialSearch.lastUsed.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {materialSearch.lastUsed.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => applyMaterial(m)}
                  className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-200 border border-slate-600 hover:border-amber-500"
                >
                  {m.materialCode}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Quantity *</label>
          <input
            type="number"
            min={0.001}
            step="any"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Lot number</label>
          <input
            type="text"
            value={lotNumber}
            onChange={(e) => setLotNumber(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Cost per unit (₹)</label>
          <input
            type="number"
            min={0}
            step="any"
            value={costPerUnit}
            onChange={(e) => setCostPerUnit(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 text-white font-medium"
        >
          {submitting ? 'Posting…' : 'Post GRN'}
        </button>
      </form>
    </div>
  )
}
