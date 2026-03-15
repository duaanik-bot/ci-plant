'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

const UNITS = ['sheets', 'kg', 'litres', 'metres', 'pieces']
type Supplier = { id: string; name: string }

export default function NewMaterialPage() {
  const router = useRouter()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [materialCode, setMaterialCode] = useState('')
  const [description, setDescription] = useState('')
  const [unit, setUnit] = useState('sheets')
  const [reorderPoint, setReorderPoint] = useState('0')
  const [safetyStock, setSafetyStock] = useState('0')
  const [storageLocation, setStorageLocation] = useState('')
  const [leadTimeDays, setLeadTimeDays] = useState('7')
  const [supplierId, setSupplierId] = useState('')
  const [weightedAvgCost, setWeightedAvgCost] = useState('0')
  const [active, setActive] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetch('/api/masters/suppliers')
      .then((r) => r.json())
      .then((data) => setSuppliers(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)
    try {
      const res = await fetch('/api/masters/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialCode: materialCode.trim(),
          description: description.trim(),
          unit,
          reorderPoint: Number(reorderPoint) || 0,
          safetyStock: Number(safetyStock) || 0,
          storageLocation: storageLocation.trim() || undefined,
          leadTimeDays: Number(leadTimeDays) || 7,
          supplierId: supplierId || null,
          weightedAvgCost: Number(weightedAvgCost) || 0,
          active,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFieldErrors(data.fields || {})
        toast.error(data.error || 'Failed')
        return
      }
      toast.success('Material created')
      router.push('/masters/materials')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-white mb-4">New material</h2>
      <p className="text-slate-400 text-sm mb-2">e.g. BRD-SBS-300, INK-CMYK-SET</p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Material code *</label>
          <input
            value={materialCode}
            onChange={(e) => setMaterialCode(e.target.value)}
            placeholder="BRD-SBS-300"
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white ${
              fieldErrors.materialCode ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {fieldErrors.materialCode && <p className="mt-1 text-sm text-red-400">{fieldErrors.materialCode}</p>}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Description *</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white ${
              fieldErrors.description ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {fieldErrors.description && <p className="mt-1 text-sm text-red-400">{fieldErrors.description}</p>}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Unit *</label>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Reorder point</label>
            <input
              type="number"
              min={0}
              value={reorderPoint}
              onChange={(e) => setReorderPoint(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Safety stock</label>
            <input
              type="number"
              min={0}
              value={safetyStock}
              onChange={(e) => setSafetyStock(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Storage location</label>
          <input
            value={storageLocation}
            onChange={(e) => setStorageLocation(e.target.value)}
            placeholder="Rack A-3"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Lead time (days)</label>
          <input
            type="number"
            min={0}
            value={leadTimeDays}
            onChange={(e) => setLeadTimeDays(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Primary supplier</label>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            <option value="">None</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Weighted avg cost (per unit)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={weightedAvgCost}
            onChange={(e) => setWeightedAvgCost(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="active"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="rounded border-slate-600"
          />
          <label htmlFor="active" className="text-sm text-slate-300">Active</label>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 text-white"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link href="/masters/materials" className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
