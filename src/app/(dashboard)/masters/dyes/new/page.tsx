'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { DYE_TYPES } from '@/lib/constants'

export default function NewDyePage() {
  const router = useRouter()
  const [form, setForm] = useState({
    dyeNumber: '',
    dyeType: DYE_TYPES[0] ?? '',
    ups: '1',
    sheetSize: '',
    cartonSize: '',
    location: '',
    maxImpressions: '500000',
  })
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.dyeNumber || !form.sheetSize || !form.cartonSize) {
      toast.error('Dye number, sheet size and carton size are required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/masters/dyes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dyeNumber: Number(form.dyeNumber),
          dyeType: form.dyeType,
          ups: Number(form.ups),
          sheetSize: form.sheetSize,
          cartonSize: form.cartonSize,
          location: form.location || undefined,
          maxImpressions: Number(form.maxImpressions) || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create dye')
      toast.success('Dye created')
      router.push('/masters/dyes')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-xl">
      <h2 className="text-lg font-semibold text-white">Add Dye</h2>
      <div className="grid md:grid-cols-2 gap-4 bg-slate-900 rounded-lg border border-slate-700 p-4 text-sm">
        <div>
          <label className="block text-slate-400 mb-1">Dye number*</label>
          <input
            type="number"
            value={form.dyeNumber}
            onChange={(e) => setForm((f) => ({ ...f, dyeNumber: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Type*</label>
          <select
            value={form.dyeType}
            onChange={(e) => setForm((f) => ({ ...f, dyeType: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            {DYE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-slate-400 mb-1">UPS*</label>
          <input
            type="number"
            min={1}
            value={form.ups}
            onChange={(e) => setForm((f) => ({ ...f, ups: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Sheet size*</label>
          <input
            type="text"
            value={form.sheetSize}
            onChange={(e) => setForm((f) => ({ ...f, sheetSize: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Carton size*</label>
          <input
            type="text"
            value={form.cartonSize}
            onChange={(e) => setForm((f) => ({ ...f, cartonSize: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Location</label>
          <input
            type="text"
            value={form.location}
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Max impressions</label>
          <input
            type="number"
            min={1}
            value={form.maxImpressions}
            onChange={(e) => setForm((f) => ({ ...f, maxImpressions: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push('/masters/dyes')}
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

