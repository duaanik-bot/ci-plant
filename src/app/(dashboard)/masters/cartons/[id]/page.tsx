'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { BOARD_GRADES, CARTON_CONSTRUCTIONS, PAPER_TYPES, GSM_CALIPER_MAP } from '@/lib/constants'

type CartonDetail = {
  id: string
  cartonName: string
  customerId: string
  gsm: number | null
  boardGrade: string | null
  paperType: string | null
  plyCount: number | null
  caliperMicrons?: number | null
  finishedLength: number | null
  finishedWidth: number | null
  finishedHeight: number | null
  blankLength: number | null
  blankWidth: number | null
  hasWindow: boolean
  windowLength: number | null
  windowWidth: number | null
  batchSpaceL: number | null
  batchSpaceW: number | null
  mrpSpaceL: number | null
  mrpSpaceW: number | null
  expirySpaceL: number | null
  expirySpaceW: number | null
  cartonConstruct: string | null
  glueType: string | null
  rate: number | null
  gstPct: number
  active: boolean
}

type Customer = { id: string; name: string }

export default function CartonEditPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string

  const [carton, setCarton] = useState<CartonDetail | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [activeTab, setActiveTab] = useState<'basic' | 'dimensions' | 'board' | 'print' | 'finishing' | 'cutting' | 'pharma'>('basic')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const [cartonRes, custRes] = await Promise.all([
          fetch(`/api/masters/cartons/${id}`),
          fetch('/api/masters/customers'),
        ])
        const cartonJson = await cartonRes.json()
        if (!cartonRes.ok) throw new Error(cartonJson.error || 'Failed to load carton')
        setCarton(cartonJson)
        const custJson = await custRes.json()
        setCustomers(Array.isArray(custJson) ? custJson : [])
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to load')
      }
    }
    load()
  }, [id])

  function update<K extends keyof CartonDetail>(key: K, value: CartonDetail[K]) {
    setCarton((c) => (c ? { ...c, [key]: value } : c))
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!carton) return
    setSaving(true)
    try {
      const res = await fetch(`/api/masters/cartons/${carton.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartonName: carton.cartonName,
          boardGrade: carton.boardGrade,
          gsm: carton.gsm,
          caliperMicrons: carton.caliperMicrons,
          paperType: carton.paperType,
          plyCount: carton.plyCount,
          rate: carton.rate,
          gstPct: carton.gstPct,
          active: carton.active,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success('Carton updated')
      router.push('/masters/cartons')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (!carton) return <div className="text-slate-400">Loading…</div>

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Edit Carton</h2>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 text-xs">
        {[
          { id: 'basic', label: 'Basic Info' },
          { id: 'dimensions', label: 'Dimensions' },
          { id: 'board', label: 'Board Spec' },
          { id: 'print', label: 'Print Spec' },
          { id: 'finishing', label: 'Finishing' },
          { id: 'cutting', label: 'Cutting & Pasting' },
          { id: 'pharma', label: 'Pharma Compliance' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id as any)}
            className={`px-3 py-1.5 rounded-full border ${
              activeTab === t.id
                ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                : 'border-slate-700 bg-slate-900 text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content (simplified for now: basic + board + dimensions + pharma spaces) */}
      {activeTab === 'basic' && (
        <div className="grid md:grid-cols-2 gap-4 bg-slate-900 rounded-lg border border-slate-700 p-4 text-sm">
          <div>
            <label className="block text-slate-400 mb-1">Carton name</label>
            <input
              type="text"
              value={carton.cartonName}
              onChange={(e) => update('cartonName', e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Client</label>
            <select
              value={carton.customerId}
              onChange={(e) => update('customerId', e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              disabled
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Rate (₹/1000)</label>
            <input
              type="number"
              min={0}
              value={carton.rate ?? ''}
              onChange={(e) => update('rate', e.target.value ? Number(e.target.value) : null)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">GST %</label>
            <input
              type="number"
              min={0}
              max={28}
              value={carton.gstPct}
              onChange={(e) => update('gstPct', Number(e.target.value) || 0)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div className="col-span-2 flex items-center gap-2 mt-2">
            <input
              id="active"
              type="checkbox"
              checked={carton.active}
              onChange={(e) => update('active', e.target.checked)}
              className="rounded border-slate-600 bg-slate-800"
            />
            <label htmlFor="active" className="text-slate-300 text-sm">
              Active
            </label>
          </div>
        </div>
      )}

      {activeTab === 'dimensions' && (
        <div className="grid md:grid-cols-3 gap-4 bg-slate-900 rounded-lg border border-slate-700 p-4 text-sm">
          <div>
            <label className="block text-slate-400 mb-1">Finished length (mm)</label>
            <input
              type="number"
              value={carton.finishedLength ?? ''}
              onChange={(e) =>
                update('finishedLength', e.target.value ? Number(e.target.value) : null)
              }
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Finished width (mm)</label>
            <input
              type="number"
              value={carton.finishedWidth ?? ''}
              onChange={(e) =>
                update('finishedWidth', e.target.value ? Number(e.target.value) : null)
              }
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Finished height (mm)</label>
            <input
              type="number"
              value={carton.finishedHeight ?? ''}
              onChange={(e) =>
                update('finishedHeight', e.target.value ? Number(e.target.value) : null)
              }
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
        </div>
      )}

      {activeTab === 'board' && (
        <div className="grid md:grid-cols-2 gap-4 bg-slate-900 rounded-lg border border-slate-700 p-4 text-sm">
          <div>
            <label className="block text-slate-400 mb-1">Board grade</label>
            <select
              value={carton.boardGrade ?? ''}
              onChange={(e) => update('boardGrade', e.target.value || null)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            >
              <option value="">Select grade…</option>
              {BOARD_GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-400 mb-1">GSM</label>
            <input
              type="number"
              value={carton.gsm ?? ''}
              onChange={(e) => {
                const v = e.target.value ? Number(e.target.value) : null
                update('gsm', v)
                if (v && GSM_CALIPER_MAP[v]) {
                  update('caliperMicrons', GSM_CALIPER_MAP[v] as any)
                }
              }}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
        </div>
      )}

      {activeTab === 'pharma' && (
        <div className="bg-slate-900 rounded-lg border border-slate-700 p-4 text-sm">
          <p className="text-slate-400">
            Pharma compliance fields (drug schedule, regulatory text, ISO / WHO / FSSAI) can be
            completed here in a later pass.
          </p>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={() => router.push('/masters/cartons')}
          className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

