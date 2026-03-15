'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type InventoryItem = { id: string; materialCode: string; description: string; unit: string }

export default function GrnPage() {
  const router = useRouter()
  const [materials, setMaterials] = useState<InventoryItem[]>([])
  const [materialId, setMaterialId] = useState('')
  const [qty, setQty] = useState('')
  const [lotNumber, setLotNumber] = useState('')
  const [costPerUnit, setCostPerUnit] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetch('/api/inventory')
      .then((r) => r.json())
      .then((data) => setMaterials(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

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
          <select
            value={materialId}
            onChange={(e) => setMaterialId(e.target.value)}
            required
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            <option value="">Select</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>{m.materialCode} — {m.description}</option>
            ))}
          </select>
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
