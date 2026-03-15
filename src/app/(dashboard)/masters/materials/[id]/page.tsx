'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

const UNITS = ['sheets', 'kg', 'litres', 'metres', 'pieces']
type Supplier = { id: string; name: string }
type Material = {
  id: string
  materialCode: string
  description: string
  unit: string
  reorderPoint: number
  safetyStock: number
  storageLocation: string | null
  leadTimeDays: number
  supplierId: string | null
  weightedAvgCost: number
  active: boolean
  supplier: { id: string; name: string } | null
}

export default function EditMaterialPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [material, setMaterial] = useState<Material | null>(null)
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
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/masters/materials').then((r) => r.json()),
      fetch('/api/masters/suppliers').then((r) => r.json()),
    ]).then(([mats, supps]) => {
      const m = Array.isArray(mats) ? mats.find((x: Material) => x.id === id) : null
      if (m) {
        setMaterial(m)
        setMaterialCode(m.materialCode)
        setDescription(m.description)
        setUnit(m.unit)
        setReorderPoint(String(m.reorderPoint))
        setSafetyStock(String(m.safetyStock))
        setStorageLocation(m.storageLocation ?? '')
        setLeadTimeDays(String(m.leadTimeDays))
        setSupplierId(m.supplierId ?? m.supplier?.id ?? '')
        setWeightedAvgCost(String(m.weightedAvgCost))
        setActive(m.active)
      }
      setSuppliers(Array.isArray(supps) ? supps : [])
    }).catch(() => toast.error('Failed to load')).finally(() => setLoading(false))
  }, [id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)
    try {
      const res = await fetch(`/api/masters/materials/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialCode: materialCode.trim(),
          description: description.trim(),
          unit,
          reorderPoint: Number(reorderPoint) || 0,
          safetyStock: Number(safetyStock) || 0,
          storageLocation: storageLocation.trim() || null,
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
      toast.success('Material updated')
      router.push('/masters/materials')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="text-slate-400">Loading…</div>
  if (!material) return <div className="text-red-400">Material not found</div>

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-white mb-4">Edit material</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Material code *</label>
          <input
            value={materialCode}
            onChange={(e) => setMaterialCode(e.target.value)}
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
          <label className="block text-sm text-slate-400 mb-1">Unit</label>
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
          <label className="block text-sm text-slate-400 mb-1">Weighted avg cost</label>
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
