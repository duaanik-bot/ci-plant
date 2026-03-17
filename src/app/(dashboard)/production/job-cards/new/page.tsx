'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'

type PurchaseOrder = {
  id: string
  poNumber: string
  customer: { id: string; name: string }
  lineItems: {
    id: string
    cartonName: string
    quantity: number
    setNumber: string | null
    jobCardNumber: number | null
    planningStatus: string
  }[]
}

export default function NewJobCardPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [poId, setPoId] = useState('')
  const [lineId, setLineId] = useState('')
  const [requiredSheets, setRequiredSheets] = useState('')
  const [wastageSheets, setWastageSheets] = useState('0')
  const [assignedOperator, setAssignedOperator] = useState('')
  const [batchNumber, setBatchNumber] = useState('')
  const [saving, setSaving] = useState(false)

  const poSearch = useAutoPopulate<PurchaseOrder>({
    storageKey: 'jobcard-po',
    search: async (query: string) => {
      const res = await fetch('/api/purchase-orders')
      const data = (await res.json()) as PurchaseOrder[]
      if (!Array.isArray(data)) return []
      const q = query.toLowerCase()
      return data.filter(
        (p) =>
          p.poNumber.toLowerCase().includes(q) ||
          (p.customer?.name ?? '').toLowerCase().includes(q),
      )
    },
    getId: (p) => p.id,
    getLabel: (p) => `${p.poNumber} — ${p.customer?.name ?? ''}`,
  })

  const applyPo = (p: PurchaseOrder) => {
    poSearch.select(p)
    setPoId(p.id)
    setLineId('')
  }

  useEffect(() => {
    fetch('/api/purchase-orders')
      .then((r) => r.json())
      .then((data) => setPos(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load purchase orders'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const qpPoId = searchParams.get('poId')
    const qpLineId = searchParams.get('lineId')
    if (qpPoId) setPoId(qpPoId)
    if (qpLineId) setLineId(qpLineId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedPo = useMemo(() => pos.find((p) => p.id === poId) || null, [pos, poId])
  const selectedLine = useMemo(
    () => selectedPo?.lineItems.find((l) => l.id === lineId) || null,
    [selectedPo, lineId]
  )

  const availableLines = useMemo(() => {
    if (!selectedPo) return []
    return selectedPo.lineItems.filter((l) => !l.jobCardNumber)
  }, [selectedPo])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!lineId) {
      toast.error('Select a PO line item')
      return
    }
    if (!requiredSheets || Number(requiredSheets) <= 0) {
      toast.error('Required sheets must be > 0')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/job-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poLineItemId: lineId,
          requiredSheets: Number(requiredSheets),
          wastageSheets: Number(wastageSheets || '0'),
          assignedOperator: assignedOperator || undefined,
          batchNumber: batchNumber || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create job card')
      toast.success('Job card created')
      router.push('/production/job-cards')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <form onSubmit={handleSubmit} className="p-4 max-w-4xl mx-auto space-y-4">
      <h1 className="text-xl font-bold text-amber-400">New Job Card (from Customer PO)</h1>

      <div className="grid md:grid-cols-2 gap-4 bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm">
        <div>
          <label className="block text-slate-400 mb-1">Purchase order*</label>
          <input
            type="text"
            value={poSearch.query}
            onChange={(e) => {
              poSearch.setQuery(e.target.value)
              setPoId('')
              setLineId('')
            }}
            placeholder="Search PO number or customer…"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
          {poSearch.loading && (
            <p className="text-xs text-slate-400 mt-0.5">Searching…</p>
          )}
          {poSearch.options.length > 0 && (
            <div className="mt-0.5 rounded border border-slate-700 bg-slate-900 max-h-40 overflow-y-auto">
              {poSearch.options.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPo(p)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 text-slate-100"
                >
                  {p.poNumber} — {p.customer?.name}
                </button>
              ))}
            </div>
          )}
          {poSearch.lastUsed.length > 0 && !poSearch.query && (
            <div className="mt-1 flex flex-wrap gap-1">
              {poSearch.lastUsed.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPo(p)}
                  className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-200 border border-slate-600 hover:border-amber-500"
                >
                  {p.poNumber}
                </button>
              ))}
            </div>
          )}
          {selectedPo && (
            <p className="text-xs text-slate-500 mt-1">Selected: {selectedPo.poNumber}</p>
          )}
        </div>
        <div>
          <label className="block text-slate-400 mb-1">PO line item*</label>
          <select
            value={lineId}
            onChange={(e) => setLineId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            disabled={!selectedPo}
          >
            <option value="">Select line…</option>
            {availableLines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.cartonName} · Qty {l.quantity} {l.setNumber ? `· Set ${l.setNumber}` : ''}
              </option>
            ))}
          </select>
          {!!selectedPo && availableLines.length === 0 && (
            <p className="text-xs text-slate-500 mt-1">All lines already have job cards.</p>
          )}
        </div>

        <div>
          <label className="block text-slate-400 mb-1">Required sheets*</label>
          <input
            type="number"
            min={1}
            value={requiredSheets}
            onChange={(e) => setRequiredSheets(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
          {selectedLine && (
            <p className="text-xs text-slate-500 mt-1">
              Selected: {selectedLine.cartonName} (PO qty {selectedLine.quantity})
            </p>
          )}
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Wastage sheets</label>
          <input
            type="number"
            min={0}
            value={wastageSheets}
            onChange={(e) => setWastageSheets(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Assigned operator</label>
          <input
            type="text"
            value={assignedOperator}
            onChange={(e) => setAssignedOperator(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Batch number</label>
          <input
            type="text"
            value={batchNumber}
            onChange={(e) => setBatchNumber(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push('/production/job-cards')}
          className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
        >
          {saving ? 'Saving…' : 'Create job card'}
        </button>
      </div>
    </form>
  )
}

