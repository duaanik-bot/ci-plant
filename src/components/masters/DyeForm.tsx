'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { DYE_TYPES } from '@/lib/constants'

export type DyeFormData = {
  dyeNumber: string
  dyeType: string
  ups: string
  sheetLength: string
  sheetWidth: string
  cartonL: string
  cartonW: string
  cartonH: string
  location: string
  maxImpressions: string
  condition: string
}

const EMPTY: DyeFormData = {
  dyeNumber: '',
  dyeType: DYE_TYPES[0] ?? '',
  ups: '1',
  sheetLength: '',
  sheetWidth: '',
  cartonL: '',
  cartonW: '',
  cartonH: '',
  location: '',
  maxImpressions: '100000',
  condition: 'Good',
}

type Props = {
  mode: 'ADD' | 'EDIT'
  initialData?: Partial<DyeFormData> & { id?: string }
}

export default function DyeForm({ mode, initialData }: Props) {
  const router = useRouter()
  const [autoGenerate, setAutoGenerate] = useState(mode === 'ADD')
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const [f, setF] = useState<DyeFormData>(() => {
    if (initialData) {
      return { ...EMPTY, ...Object.fromEntries(Object.entries(initialData).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) } as DyeFormData
    }
    return { ...EMPTY }
  })

  function patch(key: keyof DyeFormData, value: string) {
    setF((p) => ({ ...p, [key]: value }))
    setFieldErrors((p) => { const n = { ...p }; delete n[key]; return n })
  }

  function toggleAutoGenerate() {
    setAutoGenerate((prev) => {
      if (!prev) { patch('dyeNumber', ''); setFieldErrors((p) => { const n = { ...p }; delete n.dyeNumber; return n }) }
      return !prev
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const err: Record<string, string> = {}

    if (!autoGenerate && !f.dyeNumber.trim()) err.dyeNumber = 'Die number is required'
    if (!f.sheetLength || Number(f.sheetLength) <= 0) err.sheetLength = 'Required'
    if (!f.sheetWidth || Number(f.sheetWidth) <= 0) err.sheetWidth = 'Required'
    if (!f.cartonL || Number(f.cartonL) <= 0) err.cartonL = 'Required'
    if (!f.cartonW || Number(f.cartonW) <= 0) err.cartonW = 'Required'
    if (!f.cartonH || Number(f.cartonH) <= 0) err.cartonH = 'Required'
    if (!f.ups || Number(f.ups) < 1) err.ups = 'Required'

    setFieldErrors(err)
    if (Object.keys(err).length > 0) { toast.error('Please fix the highlighted fields'); return }

    setSaving(true)
    try {
      const payload = mode === 'ADD'
        ? {
            autoGenerate,
            dyeNumber: autoGenerate ? undefined : Number(f.dyeNumber),
            dyeType: f.dyeType,
            ups: Number(f.ups),
            sheetLength: Number(f.sheetLength),
            sheetWidth: Number(f.sheetWidth),
            cartonL: Number(f.cartonL),
            cartonW: Number(f.cartonW),
            cartonH: Number(f.cartonH),
            location: f.location || undefined,
          }
        : {
            dyeType: f.dyeType,
            ups: Number(f.ups),
            sheetSize: `${f.sheetLength}x${f.sheetWidth}`,
            cartonSize: `${f.cartonL}x${f.cartonW}x${f.cartonH}`,
            location: f.location || null,
            maxImpressions: Number(f.maxImpressions) || 100000,
            conditionRating: f.condition,
            condition: f.condition,
          }

      const url = mode === 'ADD' ? '/api/masters/dyes' : `/api/masters/dyes/${initialData?.id}`
      const method = mode === 'ADD' ? 'POST' : 'PUT'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const json = await res.json()
      if (!res.ok) {
        if (json.fields) setFieldErrors((prev) => ({ ...prev, ...json.fields }))
        throw new Error(json.error || 'Failed')
      }
      toast.success(mode === 'ADD' ? `Die #${json.dyeNumber} created` : 'Die updated')
      router.push('/masters/dyes')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const inpCls = (errKey?: string) =>
    `w-full px-3 py-2 rounded-lg bg-ds-elevated border text-foreground text-sm ${errKey && fieldErrors[errKey] ? 'border-red-500' : 'border-ds-line/60'}`

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
      <h2 className="text-lg font-semibold text-foreground">{mode === 'ADD' ? 'Add Die' : 'Edit Die'}</h2>

      {/* Die Number + Auto Toggle */}
      <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-ds-ink-muted font-medium">Die Number</label>
          {mode === 'ADD' && (
            <button type="button" onClick={toggleAutoGenerate} className="flex items-center gap-2 text-xs">
              <span className="text-ds-ink-muted">Auto-generate</span>
              <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${autoGenerate ? 'bg-ds-warning' : 'bg-ds-line/30'}`}>
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-card transition-transform ${autoGenerate ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
              </span>
            </button>
          )}
        </div>
        <input
          type="number"
          value={autoGenerate && mode === 'ADD' ? '' : f.dyeNumber}
          onChange={(e) => patch('dyeNumber', e.target.value)}
          disabled={autoGenerate && mode === 'ADD' || mode === 'EDIT'}
          placeholder={autoGenerate && mode === 'ADD' ? 'AUTO-GEN (assigned on save)' : 'Die number'}
          className={`${inpCls('dyeNumber')} ${(autoGenerate && mode === 'ADD') || mode === 'EDIT' ? 'opacity-50 cursor-not-allowed' : ''}`}
        />
        {fieldErrors.dyeNumber && <p className="text-xs text-red-400">{fieldErrors.dyeNumber}</p>}
      </div>

      {/* Type & UPS */}
      <div className="grid grid-cols-2 gap-4 bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm">
        <div>
          <label className="block text-ds-ink-muted mb-1">Die type *</label>
          <select value={f.dyeType} onChange={(e) => patch('dyeType', e.target.value)} className={inpCls()}>
            {DYE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-ds-ink-muted mb-1">UPS *</label>
          <input type="number" min={1} value={f.ups} onChange={(e) => patch('ups', e.target.value)} className={inpCls('ups')} />
          {fieldErrors.ups && <p className="text-xs text-red-400">{fieldErrors.ups}</p>}
        </div>
      </div>

      {/* Sheet Size (L x W) */}
      <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm space-y-2">
        <label className="block text-ds-ink-muted font-medium">Sheet Size (mm) *</label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <input type="number" step="0.01" min={0} placeholder="Length" value={f.sheetLength} onChange={(e) => patch('sheetLength', e.target.value)} className={inpCls('sheetLength')} />
            {fieldErrors.sheetLength && <p className="text-xs text-red-400 mt-0.5">{fieldErrors.sheetLength}</p>}
          </div>
          <div>
            <input type="number" step="0.01" min={0} placeholder="Width" value={f.sheetWidth} onChange={(e) => patch('sheetWidth', e.target.value)} className={inpCls('sheetWidth')} />
            {fieldErrors.sheetWidth && <p className="text-xs text-red-400 mt-0.5">{fieldErrors.sheetWidth}</p>}
          </div>
        </div>
        {f.sheetLength && f.sheetWidth && <p className="text-xs text-ds-ink-faint">Preview: {f.sheetLength}&times;{f.sheetWidth}</p>}
      </div>

      {/* Carton Size (L x W x H) */}
      <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm space-y-2">
        <label className="block text-ds-ink-muted font-medium">Carton Size (mm) *</label>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <input type="number" step="0.01" min={0} placeholder="L" value={f.cartonL} onChange={(e) => patch('cartonL', e.target.value)} className={inpCls('cartonL')} />
            {fieldErrors.cartonL && <p className="text-xs text-red-400 mt-0.5">{fieldErrors.cartonL}</p>}
          </div>
          <div>
            <input type="number" step="0.01" min={0} placeholder="W" value={f.cartonW} onChange={(e) => patch('cartonW', e.target.value)} className={inpCls('cartonW')} />
            {fieldErrors.cartonW && <p className="text-xs text-red-400 mt-0.5">{fieldErrors.cartonW}</p>}
          </div>
          <div>
            <input type="number" step="0.01" min={0} placeholder="H" value={f.cartonH} onChange={(e) => patch('cartonH', e.target.value)} className={inpCls('cartonH')} />
            {fieldErrors.cartonH && <p className="text-xs text-red-400 mt-0.5">{fieldErrors.cartonH}</p>}
          </div>
        </div>
        {f.cartonL && f.cartonW && f.cartonH && <p className="text-xs text-ds-ink-faint">Preview: {f.cartonL}&times;{f.cartonW}&times;{f.cartonH}</p>}
      </div>

      {/* Location & Condition & Max Impressions */}
      <div className="grid grid-cols-2 gap-4 bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm">
        <div>
          <label className="block text-ds-ink-muted mb-1">Storage location</label>
          <input type="text" value={f.location} onChange={(e) => patch('location', e.target.value)} placeholder="e.g. Rack A-3" className={inpCls()} />
        </div>
        <div>
          <label className="block text-ds-ink-muted mb-1">Max impressions</label>
          <input type="number" min={1} value={f.maxImpressions} onChange={(e) => patch('maxImpressions', e.target.value)} className={inpCls()} />
        </div>
        <div>
          <label className="block text-ds-ink-muted mb-1">Condition</label>
          <input type="text" value={f.condition} onChange={(e) => patch('condition', e.target.value)} className={inpCls()} />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => router.push('/masters/dyes')} className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm">Cancel</button>
        <button type="submit" disabled={saving} className="px-4 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:opacity-50 text-primary-foreground text-sm font-medium">
          {saving ? 'Saving...' : mode === 'ADD' ? 'Save Master' : 'Update Master'}
        </button>
      </div>
    </form>
  )
}
