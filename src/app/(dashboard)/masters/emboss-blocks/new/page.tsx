'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

const BLOCK_TYPES = ['Embossing', 'Leafing', 'Embossing + Leafing', 'Standard']
const BLOCK_MATERIALS = ['Magnesium', 'Brass', 'Copper', 'Other']

export default function NewEmbossBlockPage() {
  const router = useRouter()
  const [form, setForm] = useState({
    blockCode: '',
    cartonName: '',
    blockType: BLOCK_TYPES[0] ?? 'Standard',
    blockMaterial: BLOCK_MATERIALS[0] ?? 'Magnesium',
    blockSize: '',
    embossDepth: '',
    storageLocation: '',
    maxImpressions: '100000',
    condition: 'Good',
  })
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.blockCode.trim()) {
      toast.error('Block code is required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/masters/emboss-blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blockCode: form.blockCode.trim(),
          cartonName: form.cartonName.trim() || null,
          blockType: form.blockType,
          blockMaterial: form.blockMaterial,
          blockSize: form.blockSize.trim() || null,
          embossDepth: form.embossDepth ? Number(form.embossDepth) : null,
          storageLocation: form.storageLocation.trim() || null,
          maxImpressions: Number(form.maxImpressions) || 100000,
          condition: form.condition.trim() || 'Good',
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create block')
      toast.success('Emboss block created')
      router.push('/masters/emboss-blocks')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-xl">
      <h2 className="text-lg font-semibold text-white">Add Emboss Block</h2>
      <div className="grid md:grid-cols-2 gap-4 bg-slate-900 rounded-lg border border-slate-700 p-4 text-sm">
        <div>
          <label className="block text-slate-400 mb-1">Block code *</label>
          <input
            type="text"
            value={form.blockCode}
            onChange={(e) => setForm((f) => ({ ...f, blockCode: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            placeholder="e.g. EB-001"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Carton name</label>
          <input
            type="text"
            value={form.cartonName}
            onChange={(e) => setForm((f) => ({ ...f, cartonName: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Block type *</label>
          <select
            value={form.blockType}
            onChange={(e) => setForm((f) => ({ ...f, blockType: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            {BLOCK_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Material</label>
          <select
            value={form.blockMaterial}
            onChange={(e) => setForm((f) => ({ ...f, blockMaterial: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            {BLOCK_MATERIALS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Block size</label>
          <input
            type="text"
            value={form.blockSize}
            onChange={(e) => setForm((f) => ({ ...f, blockSize: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            placeholder="e.g. 24×18"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Emboss depth (mm)</label>
          <input
            type="number"
            step="0.1"
            value={form.embossDepth}
            onChange={(e) => setForm((f) => ({ ...f, embossDepth: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Storage location</label>
          <input
            type="text"
            value={form.storageLocation}
            onChange={(e) => setForm((f) => ({ ...f, storageLocation: e.target.value }))}
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
        <div>
          <label className="block text-slate-400 mb-1">Condition</label>
          <input
            type="text"
            value={form.condition}
            onChange={(e) => setForm((f) => ({ ...f, condition: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push('/masters/emboss-blocks')}
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
