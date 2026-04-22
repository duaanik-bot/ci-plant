'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

const UNIT_OPTIONS = [
  { value: 'sheets', label: 'Sheets' },
  { value: 'packets', label: 'Packets' },
  { value: 'kg', label: 'KG' },
  { value: 'grs', label: 'GRS' },
  { value: 'tonnes', label: 'Tonnes' },
]
const BOARD_TYPES = ['FBB', 'SAFFIRE', 'WB DUplex', 'GB Duples', 'CFBB', 'Artcard', 'Maplitho']
const GRAIN_DIRECTIONS = ['Long Grain', 'Short Grain']

type Supplier = { id: string; name: string }

function calcSheetWeight(l: number, w: number, gsm: number) {
  if (!Number.isFinite(l) || !Number.isFinite(w) || !Number.isFinite(gsm) || l <= 0 || w <= 0 || gsm <= 0) return 0
  return parseFloat(((l * w * gsm) / 1_000_000).toFixed(2))
}

function stockHealth(available: number, reorder: number, safety: number): 'green' | 'yellow' | 'red' {
  if (available <= safety) return 'red'
  if (available <= reorder) return 'yellow'
  return 'green'
}

export type MaterialFormData = {
  materialCode: string
  description: string
  unit: string
  boardType: string
  gsm: string
  sheetLength: string
  sheetWidth: string
  grainDirection: string
  caliperMicrons: string
  brightnessPct: string
  moisturePct: string
  hsnCode: string
  reorderPoint: string
  safetyStock: string
  storageLocation: string
  leadTimeDays: string
  supplierId: string
  weightedAvgCost: string
  active: boolean
}

const EMPTY: MaterialFormData = {
  materialCode: '',
  description: '',
  unit: 'sheets',
  boardType: '',
  gsm: '',
  sheetLength: '',
  sheetWidth: '',
  grainDirection: '',
  caliperMicrons: '',
  brightnessPct: '',
  moisturePct: '',
  hsnCode: '',
  reorderPoint: '0',
  safetyStock: '0',
  storageLocation: '',
  leadTimeDays: '7',
  supplierId: '',
  weightedAvgCost: '0',
  active: true,
}

type Props = {
  mode: 'ADD' | 'EDIT'
  initialData?: Partial<MaterialFormData> & { id?: string; qtyAvailable?: number }
}

export default function MaterialForm({ mode, initialData }: Props) {
  const router = useRouter()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [autoCode, setAutoCode] = useState(mode === 'ADD')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const [f, setF] = useState<MaterialFormData>(() => {
    if (initialData) {
      return {
        ...EMPTY,
        ...Object.fromEntries(
          Object.entries(initialData)
            .filter(([, v]) => v != null)
            .map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v)]),
        ),
      } as MaterialFormData
    }
    return { ...EMPTY }
  })

  const qtyAvailable = initialData?.qtyAvailable ?? 0

  useEffect(() => {
    fetch('/api/masters/suppliers')
      .then((r) => r.json())
      .then((data) => setSuppliers(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  function patch(key: keyof MaterialFormData, value: string | boolean) {
    setF((p) => ({ ...p, [key]: value }))
    setFieldErrors((p) => { const n = { ...p }; delete n[key]; return n })
  }

  const sheetWeight = useMemo(
    () => calcSheetWeight(Number(f.sheetLength), Number(f.sheetWidth), Number(f.gsm)),
    [f.sheetLength, f.sheetWidth, f.gsm],
  )

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)

    const payload = {
      ...(mode === 'ADD' ? { autoGenerateCode: autoCode } : {}),
      materialCode: autoCode && mode === 'ADD' ? undefined : f.materialCode.trim(),
      description: f.description.trim() || undefined,
      unit: f.unit,
      boardType: f.boardType || null,
      gsm: f.gsm ? Number(f.gsm) : null,
      sheetLength: f.sheetLength ? Number(f.sheetLength) : null,
      sheetWidth: f.sheetWidth ? Number(f.sheetWidth) : null,
      grainDirection: f.grainDirection || null,
      caliperMicrons: f.caliperMicrons ? Number(f.caliperMicrons) : null,
      brightnessPct: f.brightnessPct ? Number(f.brightnessPct) : null,
      moisturePct: f.moisturePct ? Number(f.moisturePct) : null,
      hsnCode: f.hsnCode.trim() || null,
      reorderPoint: Number(f.reorderPoint) || 0,
      safetyStock: Number(f.safetyStock) || 0,
      storageLocation: f.storageLocation.trim() || (mode === 'ADD' ? undefined : null),
      leadTimeDays: Number(f.leadTimeDays) || 7,
      supplierId: f.supplierId || null,
      weightedAvgCost: Number(f.weightedAvgCost) || 0,
      active: f.active,
    }

    try {
      const url = mode === 'ADD' ? '/api/masters/materials' : `/api/masters/materials/${initialData?.id}`
      const method = mode === 'ADD' ? 'POST' : 'PUT'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json()
      if (!res.ok) {
        if (data.fields) setFieldErrors(data.fields)
        toast.error(data.error || 'Failed')
        return
      }
      toast.success(mode === 'ADD' ? `Material ${data.materialCode} created` : 'Material updated')
      router.push('/masters/materials')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (mode !== 'EDIT' || !initialData?.id) return
    const ok = window.confirm('Delete this material permanently? This action cannot be undone.')
    if (!ok) return

    setDeleting(true)
    try {
      const res = await fetch(`/api/masters/materials/${initialData.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to delete')
      toast.success('Material deleted')
      router.push('/masters/materials')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  const cls = 'w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground text-sm'
  const errCls = (k: string) => fieldErrors[k] ? 'border-red-500' : 'border-ds-line/60'

  const health = mode === 'EDIT' ? stockHealth(qtyAvailable, Number(f.reorderPoint), Number(f.safetyStock)) : null
  const healthColor = health ? { green: 'bg-green-500', yellow: 'bg-ds-warning', red: 'bg-red-500' }[health] : ''
  const healthLabel = health ? { green: 'Healthy', yellow: 'Low — approaching reorder point', red: 'Critical — below safety stock' }[health] : ''

  return (
    <div className="max-w-3xl">
      <div className="sticky top-0 z-20 mb-4 rounded-lg border border-ds-line/50 bg-ds-main/95 backdrop-blur p-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">
          {mode === 'ADD' ? 'New Board / Paper Material' : 'Edit Board / Paper Material'}
        </h2>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-ds-ink-muted text-sm">
            <input type="checkbox" checked={f.active} onChange={(e) => patch('active', e.target.checked)} />
            {f.active ? 'Active' : 'Deactivated'}
          </label>
          {mode === 'EDIT' && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || submitting}
              className="px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 text-foreground text-sm"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          )}
          <button
            type="button"
            onClick={() => router.push('/masters/materials')}
            className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="material-form"
            disabled={submitting}
            className="px-4 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:opacity-50 text-primary-foreground text-sm font-medium"
          >
            {submitting ? 'Saving...' : mode === 'ADD' ? 'Save Master' : 'Update Master'}
          </button>
        </div>
      </div>

      {/* Stock Health (edit only) */}
      {mode === 'EDIT' && health && (
        <div className="mb-5 bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm flex items-center gap-3">
          <span className={`h-3 w-3 rounded-full ${healthColor}`} />
          <div>
            <span className="text-ds-ink font-medium">Stock Health: </span>
            <span className="text-ds-ink-muted">{healthLabel}</span>
            <span className="text-ds-ink-faint ml-2">(Qty: {qtyAvailable} / Reorder: {f.reorderPoint} / Safety: {f.safetyStock})</span>
          </div>
        </div>
      )}

      <form id="material-form" onSubmit={handleSubmit} className="space-y-5">
        {/* Material Code + Auto Toggle */}
        <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-ds-ink-muted font-medium">Material Code {mode === 'EDIT' ? '*' : ''}</label>
            {mode === 'ADD' && (
              <button type="button" onClick={() => { setAutoCode((p) => !p); if (!autoCode) patch('materialCode', '') }} className="flex items-center gap-2 text-xs">
                <span className="text-ds-ink-muted">Auto-generate</span>
                <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${autoCode ? 'bg-ds-warning' : 'bg-ds-line/30'}`}>
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-card transition-transform ${autoCode ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </span>
              </button>
            )}
          </div>
          <input
            value={autoCode && mode === 'ADD' ? '' : f.materialCode}
            onChange={(e) => patch('materialCode', e.target.value)}
            disabled={autoCode && mode === 'ADD'}
            placeholder={autoCode && mode === 'ADD' ? 'Auto-generated from board type + GSM + size' : 'Enter code e.g. BRD-SBS-300'}
            className={`${cls} ${autoCode && mode === 'ADD' ? 'opacity-50 cursor-not-allowed' : ''} border ${errCls('materialCode')}`}
          />
          {fieldErrors.materialCode && <p className="text-xs text-red-400">{fieldErrors.materialCode}</p>}
        </div>

        {/* Board Classification */}
        <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm">
          <h3 className="text-ds-ink-muted font-medium mb-3">Board Classification</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-ds-ink-muted mb-1">Board type</label>
              <select value={f.boardType} onChange={(e) => patch('boardType', e.target.value)} className={cls}>
                <option value="">Select board type...</option>
                {BOARD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Description</label>
              <input value={f.description} onChange={(e) => patch('description', e.target.value)} className={`${cls} border ${errCls('description')}`} placeholder="e.g. Duplex Board 300gsm" />
              {fieldErrors.description && <p className="text-xs text-red-400 mt-0.5">{fieldErrors.description}</p>}
            </div>
          </div>
        </div>

        {/* Physical Attributes */}
        <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm">
          <h3 className="text-ds-ink-muted font-medium mb-3">Physical Attributes</h3>
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="block text-ds-ink-muted mb-1">GSM</label>
              <input type="number" min={0} value={f.gsm} onChange={(e) => patch('gsm', e.target.value)} className={cls} placeholder="e.g. 300" />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Sheet length (mm)</label>
              <input type="number" step="0.01" min={0} value={f.sheetLength} onChange={(e) => patch('sheetLength', e.target.value)} className={cls} />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Sheet width (mm)</label>
              <input type="number" step="0.01" min={0} value={f.sheetWidth} onChange={(e) => patch('sheetWidth', e.target.value)} className={cls} />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Sheet weight (g)</label>
              <input type="text" readOnly value={sheetWeight > 0 ? `${sheetWeight} g` : '—'} className={`${cls} opacity-60 cursor-not-allowed`} />
              <p className="text-[10px] text-ds-ink-faint mt-0.5">= L x W x GSM / 1,000,000</p>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Grain direction</label>
              <select value={f.grainDirection} onChange={(e) => patch('grainDirection', e.target.value)} className={cls}>
                <option value="">Select...</option>
                {GRAIN_DIRECTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Caliper (microns)</label>
              <input type="number" step="0.01" min={0} value={f.caliperMicrons} onChange={(e) => patch('caliperMicrons', e.target.value)} className={cls} />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Brightness %</label>
              <input type="number" step="0.1" min={0} max={100} value={f.brightnessPct} onChange={(e) => patch('brightnessPct', e.target.value)} className={cls} />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Moisture %</label>
              <input type="number" step="0.1" min={0} max={100} value={f.moisturePct} onChange={(e) => patch('moisturePct', e.target.value)} className={cls} />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">HSN code</label>
              <input value={f.hsnCode} onChange={(e) => patch('hsnCode', e.target.value)} className={cls} placeholder="e.g. 4810" />
            </div>
          </div>
        </div>

        {/* Inventory & Supply */}
        <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 text-sm">
          <h3 className="text-ds-ink-muted font-medium mb-3">Inventory & Supply</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-ds-ink-muted mb-1">Unit of measure</label>
              <select value={f.unit} onChange={(e) => patch('unit', e.target.value)} className={cls}>
                {UNIT_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Primary supplier</label>
              <select value={f.supplierId} onChange={(e) => patch('supplierId', e.target.value)} className={cls}>
                <option value="">None</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Reorder point</label>
              <input type="number" min={0} value={f.reorderPoint} onChange={(e) => patch('reorderPoint', e.target.value)} className={cls} />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Safety stock</label>
              <input type="number" min={0} value={f.safetyStock} onChange={(e) => patch('safetyStock', e.target.value)} className={cls} />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Lead time (days)</label>
              <input type="number" min={0} value={f.leadTimeDays} onChange={(e) => patch('leadTimeDays', e.target.value)} className={cls} />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Storage location</label>
              <input value={f.storageLocation} onChange={(e) => patch('storageLocation', e.target.value)} className={cls} placeholder="e.g. Rack A-3" />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Weighted avg cost</label>
              <input type="number" min={0} step="0.01" value={f.weightedAvgCost} onChange={(e) => patch('weightedAvgCost', e.target.value)} className={cls} />
            </div>
            <div />
          </div>
          {f.unit === 'kg' && sheetWeight > 0 && (
            <div className="mt-3 p-2 rounded bg-ds-elevated/60 text-xs text-ds-ink-muted">
              1 kg = ~{Math.round(1000 / sheetWeight)} sheets (at {sheetWeight}g/sheet)
            </div>
          )}
        </div>

      </form>
    </div>
  )
}
