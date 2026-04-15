'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

const BLOCK_TYPES = ['Embossing', 'Leafing', 'Embossing + Leafing', 'Standard']
const BLOCK_MATERIALS = ['Magnesium', 'Brass', 'Copper', 'Polymer', 'Other']
const CONDITIONS = ['Good', 'Worn', 'Needs Cleaning', 'Damaged', 'Destroyed']

export { BLOCK_TYPES, BLOCK_MATERIALS, CONDITIONS }

export type EmbossBlockFormData = {
  blockCode: string
  cartonName: string
  blockType: string
  blockMaterial: string
  blockSize: string
  embossDepth: string
  storageLocation: string
  maxImpressions: string
  condition: string
  manufactureDate: string
  replacesBlockId: string
  active: boolean
}

const EMPTY: EmbossBlockFormData = {
  blockCode: '',
  cartonName: '',
  blockType: BLOCK_TYPES[0],
  blockMaterial: BLOCK_MATERIALS[0],
  blockSize: '',
  embossDepth: '',
  storageLocation: '',
  maxImpressions: '100000',
  condition: 'Good',
  manufactureDate: new Date().toISOString().slice(0, 10),
  replacesBlockId: '',
  active: true,
}

type BlockOption = { id: string; blockCode: string }

type Props = {
  mode: 'ADD' | 'EDIT'
  initialData?: Partial<EmbossBlockFormData> & { id?: string; defaultMaxImpressions?: number; destroyedAt?: string; destroyReason?: string }
}

export default function EmbossBlockForm({ mode, initialData }: Props) {
  const router = useRouter()
  const [existingBlocks, setExistingBlocks] = useState<BlockOption[]>([])
  const [saving, setSaving] = useState(false)

  const [f, setF] = useState<EmbossBlockFormData>(() => {
    if (initialData) {
      return {
        ...EMPTY,
        ...Object.fromEntries(
          Object.entries(initialData)
            .filter(([, v]) => v != null)
            .map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v)]),
        ),
      } as EmbossBlockFormData
    }
    return { ...EMPTY }
  })

  useEffect(() => {
    if (mode === 'ADD') {
      fetch('/api/masters/emboss-blocks?active=false')
        .then((r) => r.json())
        .then((data) => {
          if (Array.isArray(data)) setExistingBlocks(data.map((b: BlockOption) => ({ id: b.id, blockCode: b.blockCode })))
        })
        .catch(() => {})
    }
  }, [mode])

  function patch(key: keyof EmbossBlockFormData, value: string | boolean) {
    setF((p) => ({ ...p, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!f.blockCode.trim()) { toast.error('Block code is required'); return }
    if (mode === 'ADD' && !f.manufactureDate) { toast.error('Manufacture date is required'); return }

    setSaving(true)
    try {
      const payload = mode === 'ADD'
        ? {
            blockCode: f.blockCode.trim(),
            cartonName: f.cartonName.trim() || null,
            blockType: f.blockType,
            blockMaterial: f.blockMaterial,
            blockSize: f.blockSize.trim() || null,
            embossDepth: f.embossDepth ? Number(f.embossDepth) : null,
            storageLocation: f.storageLocation.trim() || null,
            maxImpressions: Number(f.maxImpressions) || 100000,
            condition: f.condition.trim() || 'Good',
            manufactureDate: f.manufactureDate || null,
            replacesBlockId: f.replacesBlockId || null,
          }
        : {
            cartonName: f.cartonName.trim() || null,
            blockType: f.blockType,
            blockMaterial: f.blockMaterial,
            blockSize: f.blockSize.trim() || null,
            embossDepth: f.embossDepth ? Number(f.embossDepth) : null,
            storageLocation: f.storageLocation.trim() || null,
            maxImpressions: Number(f.maxImpressions) || 100000,
            condition: f.condition,
            active: f.active,
          }

      const url = mode === 'ADD' ? '/api/masters/emboss-blocks' : `/api/masters/emboss-blocks/${initialData?.id}`
      const method = mode === 'ADD' ? 'POST' : 'PUT'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed')
      toast.success(mode === 'ADD' ? 'Emboss block created' : 'Block updated')
      if (mode === 'ADD') {
        router.push('/masters/emboss-blocks')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const cls = 'w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm'

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
      {mode === 'ADD' && <h2 className="text-lg font-semibold text-white">Add Emboss Block</h2>}

      <div className="grid md:grid-cols-2 gap-4 bg-slate-900 rounded-lg border border-slate-700 p-4 text-sm">
        <div>
          <label className="block text-slate-400 mb-1">Block code *</label>
          <input
            type="text"
            value={f.blockCode}
            onChange={(e) => patch('blockCode', e.target.value)}
            disabled={mode === 'EDIT'}
            placeholder="e.g. EB-0002"
            className={`${cls} ${mode === 'EDIT' ? 'opacity-50 cursor-not-allowed' : ''}`}
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Manufacture date {mode === 'ADD' ? '*' : ''}</label>
          <input
            type="date"
            value={f.manufactureDate}
            onChange={(e) => patch('manufactureDate', e.target.value)}
            disabled={mode === 'EDIT'}
            className={`${cls} ${mode === 'EDIT' ? 'opacity-50 cursor-not-allowed' : ''}`}
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Carton name</label>
          <input type="text" value={f.cartonName} onChange={(e) => patch('cartonName', e.target.value)} className={cls} />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Block type *</label>
          <select value={f.blockType} onChange={(e) => patch('blockType', e.target.value)} className={cls}>
            {BLOCK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Material</label>
          <select value={f.blockMaterial} onChange={(e) => patch('blockMaterial', e.target.value)} className={cls}>
            {BLOCK_MATERIALS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Block size</label>
          <input type="text" value={f.blockSize} onChange={(e) => patch('blockSize', e.target.value)} className={cls} placeholder="e.g. 24x18" />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Emboss depth (mm)</label>
          <input type="number" step="0.1" value={f.embossDepth} onChange={(e) => patch('embossDepth', e.target.value)} className={cls} />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Storage location</label>
          <input type="text" value={f.storageLocation} onChange={(e) => patch('storageLocation', e.target.value)} className={cls} />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Target max impressions</label>
          <input type="number" min={1} value={f.maxImpressions} onChange={(e) => patch('maxImpressions', e.target.value)} className={cls} />
          {initialData?.defaultMaxImpressions && mode === 'EDIT' && (
            <p className="text-[10px] text-slate-500 mt-0.5">Default for {f.blockMaterial}: {initialData.defaultMaxImpressions.toLocaleString()}</p>
          )}
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Condition</label>
          {mode === 'EDIT' ? (
            <select value={f.condition} onChange={(e) => patch('condition', e.target.value)} className={cls}>
              {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input type="text" value={f.condition} onChange={(e) => patch('condition', e.target.value)} className={cls} />
          )}
        </div>

        {mode === 'ADD' && (
          <div className="md:col-span-2">
            <label className="block text-slate-400 mb-1">Replaces block (if replacement)</label>
            <select value={f.replacesBlockId} onChange={(e) => patch('replacesBlockId', e.target.value)} className={cls}>
              <option value="">None (new block)</option>
              {existingBlocks.map((b) => <option key={b.id} value={b.id}>{b.blockCode}</option>)}
            </select>
          </div>
        )}

        {mode === 'EDIT' && (
          <div className="flex items-center gap-2">
            <input type="checkbox" id="eb-active" checked={f.active} onChange={(e) => patch('active', e.target.checked)} className="rounded border-slate-600" />
            <label htmlFor="eb-active" className="text-slate-300">Active</label>
          </div>
        )}
      </div>

      {initialData?.destroyedAt && mode === 'EDIT' && (
        <p className="text-xs text-red-400">Destroyed: {initialData.destroyedAt.slice(0, 10)} &mdash; {initialData.destroyReason ?? 'No reason given'}</p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => router.push('/masters/emboss-blocks')} className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm">Cancel</button>
        <button type="submit" disabled={saving} className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium">
          {saving ? 'Saving...' : mode === 'ADD' ? 'Save Master' : 'Update Master'}
        </button>
      </div>
    </form>
  )
}
