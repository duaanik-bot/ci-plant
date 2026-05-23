'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { EffectSelect } from '@/components/ui/EffectSelect'
import { MasterSelect } from '@/components/ui/MasterSelect'
import { MASTER } from '@/lib/masters/registry'

const GRAIN_DIRECTIONS = ['Long Grain', 'Short Grain']

type Supplier = { id: string; name: string }

function calcSheetWeightByFactoryRule(lengthIn: number, widthIn: number, gsm: number, sheetsPerPacket: number) {
  if (
    !Number.isFinite(lengthIn) ||
    !Number.isFinite(widthIn) ||
    !Number.isFinite(gsm) ||
    !Number.isFinite(sheetsPerPacket) ||
    lengthIn <= 0 ||
    widthIn <= 0 ||
    gsm <= 0 ||
    sheetsPerPacket <= 0
  ) return 0
  return parseFloat(((lengthIn * widthIn * gsm) / 3100 / 5 / sheetsPerPacket).toFixed(4))
}

function defaultSheetsPerPacket(boardType: string): number | null {
  const key = boardType.trim().toLowerCase()
  if (!key) return null
  if (key.includes('fbb')) return 100
  if (key.includes('saff')) return 144
  // Legacy fallback
  if (key.includes('sbs')) return 100
  if (key.includes('dup')) return 144
  if (key.includes('duplex')) return 144
  return null
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
  attributes: string
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
  packetWeight: string
  sheetsPerPacket: string
  active: boolean
}

const EMPTY: MaterialFormData = {
  materialCode: '',
  description: '',
  unit: 'SHT',
  boardType: '',
  attributes: '',
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
  weightedAvgCost: '',
  packetWeight: '',
  sheetsPerPacket: '',
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
    const current = Number(f.sheetsPerPacket)
    if (Number.isFinite(current) && current > 0) return
    const autoDefault = defaultSheetsPerPacket(f.boardType)
    if (autoDefault != null) {
      setF((prev) => ({ ...prev, sheetsPerPacket: String(autoDefault) }))
    }
  }, [f.boardType, f.sheetsPerPacket])

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
    () =>
      calcSheetWeightByFactoryRule(
        Number(f.sheetLength),
        Number(f.sheetWidth),
        Number(f.gsm),
        Number(f.sheetsPerPacket),
      ),
    [f.sheetLength, f.sheetWidth, f.gsm, f.sheetsPerPacket],
  )

  const autoPacketWeight = useMemo(() => {
    const sheetsPerPacket = Number(f.sheetsPerPacket)
    if (!Number.isFinite(sheetsPerPacket) || sheetsPerPacket <= 0 || sheetWeight <= 0) return 0
    return parseFloat((sheetWeight * sheetsPerPacket).toFixed(3))
  }, [sheetWeight, f.sheetsPerPacket])

  const autoDescription = useMemo(() => {
    const board = f.boardType.trim()
    const gsm = f.gsm.trim()
    const attrs = f.attributes.trim()
    return [board, gsm ? `${gsm} GSM` : '', attrs].filter(Boolean).join(' · ')
  }, [f.boardType, f.gsm, f.attributes])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)

    const payload = {
      ...(mode === 'ADD' ? { autoGenerateCode: autoCode } : {}),
      materialCode: autoCode && mode === 'ADD' ? undefined : f.materialCode.trim(),
      description: autoDescription || f.description.trim() || undefined,
      unit: f.unit,
      boardType: f.boardType || null,
      attributes: f.attributes.trim() || null,
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
      packetWeight: autoPacketWeight > 0 ? autoPacketWeight : null,
      sheetsPerPacket: f.sheetsPerPacket ? Number(f.sheetsPerPacket) : null,
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
      let res = await fetch(`/api/masters/materials/${initialData.id}`, { method: 'DELETE' })
      let data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const forceOk = window.confirm(
          'This material has linked logs/records. Do you want force delete and remove associated logs?',
        )
        if (!forceOk) throw new Error(data.error || 'Failed to delete')
        res = await fetch(`/api/masters/materials/${initialData.id}?force=1`, { method: 'DELETE' })
        data = await res.json().catch(() => ({}))
      }
      if (!res.ok) throw new Error(data.error || 'Failed to delete')
      toast.success('Material deleted')
      router.push('/masters/materials')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  const cls = 'w-full px-3 py-2 rounded-ds-md bg-ds-elevated text-foreground text-sm'
  const errCls = (k: string) => fieldErrors[k] ? 'bg-[var(--error-bg)]' : ''

  const health = mode === 'EDIT' ? stockHealth(qtyAvailable, Number(f.reorderPoint), Number(f.safetyStock)) : null
  const healthColor = health ? { green: 'bg-[var(--success-bg)]', yellow: 'bg-ds-warning', red: 'bg-[var(--error-bg)]' }[health] : ''
  const healthLabel = health ? { green: 'Healthy', yellow: 'Low — approaching reorder point', red: 'Critical — below safety stock' }[health] : ''

  return (
    <div className="max-w-3xl">
      <div className="sticky top-0 z-20 mb-4 rounded-ds-md bg-ds-main/95 backdrop-blur p-3 flex items-center justify-between">
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
              className="px-3 py-1.5 rounded-ds-md bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:opacity-50 text-foreground text-sm"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          )}
          <button
            type="button"
            onClick={() => router.push('/masters/materials')}
            className="px-3 py-1.5 rounded-ds-md bg-ds-elevated text-ds-ink text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="material-form"
            disabled={submitting}
            className="px-4 py-1.5 rounded-ds-md bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)] disabled:opacity-50 text-primary-foreground text-sm font-medium"
          >
            {submitting ? 'Saving...' : mode === 'ADD' ? 'Save Master' : 'Update Master'}
          </button>
        </div>
      </div>

      {/* Stock Health (edit only) */}
      {mode === 'EDIT' && health && (
        <div className="mb-5 bg-ds-card rounded-ds-md shadow-ds-depth-sm p-4 text-sm flex items-center gap-3">
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
        <div className="bg-ds-card rounded-ds-md shadow-ds-depth-sm p-4 text-sm space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-ds-ink-muted font-medium">Material Code {mode === 'EDIT' ? '*' : ''}</label>
            {mode === 'ADD' && (
              <button type="button" onClick={() => { setAutoCode((p) => !p); if (!autoCode) patch('materialCode', '') }} className="flex items-center gap-2 text-xs">
                <span className="text-ds-ink-muted">Auto-generate</span>
                <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${autoCode ? 'bg-[var(--brand-primary)]' : 'bg-ds-line/30'}`}>
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-card transition-transform ${autoCode ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </span>
              </button>
            )}
          </div>
          <input
            value={autoCode && mode === 'ADD' ? '' : f.materialCode}
            onChange={(e) => patch('materialCode', e.target.value)}
            disabled={autoCode && mode === 'ADD'}
            placeholder={autoCode && mode === 'ADD' ? 'Auto-generated from size + board abbreviation + GSM' : 'Enter product code'}
            className={`${cls} ${autoCode && mode === 'ADD' ? 'opacity-50 cursor-not-allowed' : ''} ${errCls('materialCode')}`}
          />
          {fieldErrors.materialCode && <p className="text-xs text-[var(--error)]">{fieldErrors.materialCode}</p>}
        </div>

        {/* Board Type */}
        <div className="bg-ds-card rounded-ds-md shadow-ds-depth-sm p-4 text-sm">
          <h3 className="text-ds-ink-muted font-medium mb-3">Board Type</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-ds-ink-muted mb-1">Board Type</label>
              <EffectSelect
                category="Board Type"
                value={f.boardType}
                onChange={(next) => patch('boardType', next)}
                className={cls}
                placeholder="Select board type..."
              />
              {fieldErrors.boardType && <p className="mt-0.5 text-xs text-[var(--error)]">{fieldErrors.boardType}</p>}
            </div>
            <div className="md:col-span-2">
              <label className="block text-ds-ink-muted mb-1">Material attribute</label>
              <EffectSelect
                category="Material Attribute"
                value={f.attributes}
                onChange={(next) => patch('attributes', next)}
                className={cls}
                placeholder="Select material attribute..."
              />
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Description (auto-generated)</label>
              <input value={autoDescription || f.description} readOnly className={`${cls} ${errCls('description')} opacity-70 cursor-not-allowed`} placeholder="Auto-generated" />
              {fieldErrors.description && <p className="text-xs text-[var(--error)] mt-0.5">{fieldErrors.description}</p>}
            </div>
          </div>
        </div>

        {/* Physical Attributes */}
        <div className="bg-ds-card rounded-ds-md shadow-ds-depth-sm p-4 text-sm">
          <h3 className="text-ds-ink-muted font-medium mb-3">Physical Attributes</h3>
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="block text-ds-ink-muted mb-1">GSM</label>
              <input type="number" min={0} value={f.gsm} onChange={(e) => patch('gsm', e.target.value)} className={`${cls} ${errCls('gsm')}`} placeholder="e.g. 300" />
              {fieldErrors.gsm && <p className="mt-0.5 text-xs text-[var(--error)]">{fieldErrors.gsm}</p>}
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Sheet length (inches)</label>
              <input type="number" step="0.01" min={0} value={f.sheetLength} onChange={(e) => patch('sheetLength', e.target.value)} className={`${cls} ${errCls('sheetLength')}`} />
              {fieldErrors.sheetLength && <p className="mt-0.5 text-xs text-[var(--error)]">{fieldErrors.sheetLength}</p>}
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Sheet width (inches)</label>
              <input type="number" step="0.01" min={0} value={f.sheetWidth} onChange={(e) => patch('sheetWidth', e.target.value)} className={`${cls} ${errCls('sheetWidth')}`} />
              {fieldErrors.sheetWidth && <p className="mt-0.5 text-xs text-[var(--error)]">{fieldErrors.sheetWidth}</p>}
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Total sheets in packet / bundle</label>
              <input
                type="number"
                min={1}
                step="1"
                value={f.sheetsPerPacket}
                onChange={(e) => patch('sheetsPerPacket', e.target.value)}
                className={`${cls} ${errCls('sheetsPerPacket')}`}
                placeholder={defaultSheetsPerPacket(f.boardType) != null ? String(defaultSheetsPerPacket(f.boardType)) : 'e.g. 100'}
              />
              {fieldErrors.sheetsPerPacket && <p className="mt-0.5 text-xs text-[var(--error)]">{fieldErrors.sheetsPerPacket}</p>}
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Sheet weight (g)</label>
              <input type="text" readOnly value={sheetWeight > 0 ? `${sheetWeight} g` : '—'} className={`${cls} opacity-60 cursor-not-allowed`} />
              <p className="text-xs text-ds-ink-faint mt-0.5">= L x W x GSM / 3100 / 5 / sheets-per-packet</p>
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Packet Weight</label>
              <input
                type="number"
                min={0}
                step="0.001"
                value={autoPacketWeight > 0 ? String(autoPacketWeight) : ''}
                readOnly
                className={`${cls} ${errCls('packetWeight')} opacity-60 cursor-not-allowed`}
                placeholder="Auto-calculated"
              />
              {fieldErrors.packetWeight && <p className="mt-0.5 text-xs text-[var(--error)]">{fieldErrors.packetWeight}</p>}
            </div>
            <div>
              <label className="block text-ds-ink-muted mb-1">Grain direction</label>
              <select value={f.grainDirection} onChange={(e) => patch('grainDirection', e.target.value)} className={cls}>
                <option value="">Select...</option>
                {GRAIN_DIRECTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Inventory & Supply */}
        <div className="bg-ds-card rounded-ds-md shadow-ds-depth-sm p-4 text-sm">
          <h3 className="text-ds-ink-muted font-medium mb-3">Inventory & Supply</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-ds-ink-muted mb-1">Unit of measure</label>
              <MasterSelect
                masterKey={MASTER.UNIT}
                value={f.unit}
                onChange={(code) => patch('unit', code)}
                allowEmpty={false}
                className={cls}
              />
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
              <label className="block text-ds-ink-muted mb-1">Weighted avg cost (optional)</label>
              <input type="number" min={0} step="0.01" value={f.weightedAvgCost} onChange={(e) => patch('weightedAvgCost', e.target.value)} className={cls} placeholder="Leave blank if not available" />
            </div>
            <div />
          </div>
          {f.unit === 'KG' && sheetWeight > 0 && (
            <div className="mt-3 p-2 rounded bg-ds-elevated/60 text-xs text-ds-ink-muted">
              1 kg = ~{Math.round(1000 / sheetWeight)} sheets (at {sheetWeight}g/sheet)
            </div>
          )}
        </div>

      </form>
    </div>
  )
}
