'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'

type InventoryItem = {
  id: string
  materialCode: string
  description: string
  unit: string
  boardType: string | null
  gsm: number | null
  sheetLength: number | null
  sheetWidth: number | null
  grainDirection: string | null
  caliperMicrons: number | null
  qtyAvailable: number
  qtyQuarantine: number
  weightedAvgCost: number
}

function calcSheetWeight(l: number, w: number, gsm: number) {
  if (!l || !w || !gsm) return 0
  return parseFloat(((l * w * gsm) / 1_000_000).toFixed(4))
}

function calcGrnTotals(qty: number, isSheets: boolean, sheetWeightG: number) {
  const totalWeightKg = isSheets ? parseFloat(((qty * sheetWeightG) / 1000).toFixed(3)) : qty
  const totalSheets = isSheets ? qty : Math.round((qty * 1000) / sheetWeightG)
  return { totalWeightKg, totalSheets }
}

export default function GrnPage() {
  const router = useRouter()
  const [materialId, setMaterialId] = useState('')
  const [selectedMaterial, setSelectedMaterial] = useState<InventoryItem | null>(null)
  const [entryUnit, setEntryUnit] = useState<'sheets' | 'kg'>('sheets')
  const [qty, setQty] = useState('')
  const [lotNumber, setLotNumber] = useState('')
  const [millDate, setMillDate] = useState('')
  const [palletCount, setPalletCount] = useState('')
  const [pricePerKg, setPricePerKg] = useState('')
  const [costPerUnit, setCostPerUnit] = useState('')
  const [poReference, setPoReference] = useState('')
  const [poQty, setPoQty] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toleranceWarning, setToleranceWarning] = useState<string | null>(null)
  const [approvalOverride, setApprovalOverride] = useState(false)

  const materialSearch = useAutoPopulate<InventoryItem>({
    storageKey: 'grn-material',
    search: async (query: string) => {
      const res = await fetch('/api/inventory')
      const data = (await res.json()) as InventoryItem[]
      const q = query.toLowerCase()
      return data.filter(
        (m) =>
          m.materialCode.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q),
      )
    },
    getId: (m) => m.id,
    getLabel: (m) => `${m.materialCode} — ${m.description}`,
  })

  function applyMaterial(m: InventoryItem) {
    materialSearch.select(m)
    setMaterialId(m.id)
    setSelectedMaterial(m)
    setEntryUnit('sheets')
  }

  const isBoardType = !!(selectedMaterial?.boardType && selectedMaterial?.gsm && selectedMaterial?.sheetLength && selectedMaterial?.sheetWidth)
  const sheetWeightG = useMemo(
    () => selectedMaterial ? calcSheetWeight(
      Number(selectedMaterial.sheetLength ?? 0),
      Number(selectedMaterial.sheetWidth ?? 0),
      selectedMaterial.gsm ?? 0,
    ) : 0,
    [selectedMaterial],
  )

  const conversion = useMemo(() => {
    const q = Number(qty)
    if (!q || q <= 0 || sheetWeightG <= 0) return null
    return calcGrnTotals(q, entryUnit === 'sheets', sheetWeightG)
  }, [qty, entryUnit, sheetWeightG])

  const totalCost = useMemo(() => {
    if (!conversion) return 0
    if (isBoardType && pricePerKg) {
      return parseFloat((conversion.totalWeightKg * Number(pricePerKg)).toFixed(2))
    }
    if (costPerUnit) {
      return parseFloat((conversion.totalSheets * Number(costPerUnit)).toFixed(2))
    }
    return 0
  }, [conversion, pricePerKg, costPerUnit, isBoardType])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!materialId || !qty || Number(qty) <= 0) {
      toast.error('Select material and enter qty')
      return
    }
    setSubmitting(true)
    setToleranceWarning(null)
    try {
      const res = await fetch('/api/inventory/grn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialId,
          qty: Number(qty),
          entryUnit,
          lotNumber: lotNumber || undefined,
          millDate: millDate || null,
          palletCount: palletCount ? Number(palletCount) : null,
          pricePerKg: pricePerKg ? Number(pricePerKg) : null,
          costPerUnit: costPerUnit ? Number(costPerUnit) : undefined,
          poReference: poReference || null,
          poQty: poQty ? Number(poQty) : null,
          approvalOverride,
        }),
      })
      const data = await res.json()

      if (res.status === 422 && data.error === 'tolerance_exceeded') {
        setToleranceWarning(data.message)
        setSubmitting(false)
        return
      }

      if (!res.ok) throw new Error(data.error || 'Failed')
      toast.success(data.message)
      router.push('/inventory')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  const cls = 'w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground text-sm'

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <Link href="/inventory" className="text-ds-ink-muted hover:text-foreground text-sm mb-4 inline-block">&larr; Inventory</Link>
      <h1 className="text-xl font-bold text-ds-warning mb-4">Goods Receipt (GRN)</h1>

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* Material Search */}
        <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4">
          <MasterSearchSelect
            label="Material"
            required
            query={materialSearch.query}
            onQueryChange={(value) => {
              materialSearch.setQuery(value)
              setMaterialId('')
              setSelectedMaterial(null)
            }}
            loading={materialSearch.loading}
            options={materialSearch.options}
            lastUsed={materialSearch.lastUsed}
            onSelect={applyMaterial}
            getOptionLabel={(m) => `${m.materialCode} - ${m.description}`}
            getOptionMeta={(m) => `${m.boardType ?? m.unit}${m.gsm ? ` · ${m.gsm}gsm` : ''}`}
            placeholder="Type code or description..."
            recentLabel="Recent materials"
            loadingMessage="Searching materials..."
            emptyMessage="No material found."
          />

          {/* Material Specs Panel */}
          {selectedMaterial && isBoardType && (
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="bg-ds-elevated rounded p-2">
                <span className="text-ds-ink-muted">Board type</span>
                <p className="text-foreground font-medium">{selectedMaterial.boardType}</p>
              </div>
              <div className="bg-ds-elevated rounded p-2">
                <span className="text-ds-ink-muted">GSM</span>
                <p className="text-foreground font-medium">{selectedMaterial.gsm}</p>
              </div>
              <div className="bg-ds-elevated rounded p-2">
                <span className="text-ds-ink-muted">Size (mm)</span>
                <p className="text-foreground font-medium">{selectedMaterial.sheetLength} &times; {selectedMaterial.sheetWidth}</p>
              </div>
              <div className="bg-ds-elevated rounded p-2">
                <span className="text-ds-ink-muted">Grain</span>
                <p className="text-foreground font-medium">{selectedMaterial.grainDirection ?? '—'}</p>
              </div>
              <div className="bg-ds-elevated rounded p-2">
                <span className="text-ds-ink-muted">Sheet weight</span>
                <p className="text-foreground font-medium">{sheetWeightG > 0 ? `${sheetWeightG} g` : '—'}</p>
              </div>
              {selectedMaterial.caliperMicrons && (
                <div className="bg-ds-elevated rounded p-2">
                  <span className="text-ds-ink-muted">Caliper</span>
                  <p className="text-foreground font-medium">{selectedMaterial.caliperMicrons} &mu;</p>
                </div>
              )}
              <div className="bg-ds-elevated rounded p-2">
                <span className="text-ds-ink-muted">Current stock</span>
                <p className="text-foreground font-medium">{Number(selectedMaterial.qtyAvailable).toLocaleString()} {selectedMaterial.unit}</p>
              </div>
              <div className="bg-ds-elevated rounded p-2">
                <span className="text-ds-ink-muted">In quarantine</span>
                <p className="text-foreground font-medium">{Number(selectedMaterial.qtyQuarantine).toLocaleString()}</p>
              </div>
            </div>
          )}
        </div>

        {/* Quantity Entry */}
        <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 space-y-3">
          <h3 className="text-ds-ink-muted text-sm font-medium">Received Quantity</h3>

          {/* Unit Toggle (only for board types) */}
          {isBoardType && sheetWeightG > 0 && (
            <div className="flex gap-1 bg-ds-elevated rounded-lg p-0.5 w-fit text-sm">
              <button type="button" onClick={() => setEntryUnit('sheets')}
                className={`px-3 py-1 rounded-md transition-colors ${entryUnit === 'sheets' ? 'bg-ds-warning text-primary-foreground' : 'text-ds-ink-muted hover:text-foreground'}`}>
                Sheets
              </button>
              <button type="button" onClick={() => setEntryUnit('kg')}
                className={`px-3 py-1 rounded-md transition-colors ${entryUnit === 'kg' ? 'bg-ds-warning text-primary-foreground' : 'text-ds-ink-muted hover:text-foreground'}`}>
                kg
              </button>
            </div>
          )}

          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">
              Quantity ({entryUnit}) *
            </label>
            <input type="number" min={0.001} step="any" value={qty} onChange={(e) => setQty(e.target.value)} required className={cls} />
          </div>

          {/* Real-time Conversion */}
          {conversion && isBoardType && sheetWeightG > 0 && (
            <div className="text-xs text-ds-ink-muted bg-ds-elevated/50 rounded p-2">
              {entryUnit === 'sheets' ? (
                <span>&asymp; <strong className="text-foreground">{conversion.totalWeightKg.toFixed(2)} kg</strong> ({conversion.totalSheets.toLocaleString()} sheets &times; {sheetWeightG}g / 1000)</span>
              ) : (
                <span>&asymp; <strong className="text-foreground">{conversion.totalSheets.toLocaleString()} sheets</strong> ({conversion.totalWeightKg.toFixed(2)} kg &times; 1000 / {sheetWeightG}g)</span>
              )}
            </div>
          )}

          {/* PO Tolerance */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-ds-ink-muted mb-1">PO reference</label>
              <input type="text" value={poReference} onChange={(e) => setPoReference(e.target.value)} className={cls} placeholder="e.g. PO-2026-0042" />
            </div>
            <div>
              <label className="block text-sm text-ds-ink-muted mb-1">PO qty ({entryUnit})</label>
              <input type="number" min={0} step="any" value={poQty} onChange={(e) => setPoQty(e.target.value)} className={cls} placeholder="For tolerance check" />
            </div>
          </div>
        </div>

        {/* Tolerance Warning */}
        {toleranceWarning && (
          <div className="bg-red-900/40 border border-red-700 rounded-lg p-3 text-sm space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-red-400 text-lg">&#9888;</span>
              <span className="text-red-200">{toleranceWarning}</span>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="approvalOverride" checked={approvalOverride} onChange={(e) => setApprovalOverride(e.target.checked)} className="rounded border-ds-line/60" />
              <label htmlFor="approvalOverride" className="text-red-300 text-xs">Manager approval granted &mdash; proceed with GRN</label>
            </div>
          </div>
        )}

        {/* Pricing */}
        <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 space-y-3">
          <h3 className="text-ds-ink-muted text-sm font-medium">Pricing</h3>
          <div className="grid grid-cols-2 gap-3">
            {isBoardType ? (
              <div>
                <label className="block text-sm text-ds-ink-muted mb-1">Price per kg (\u20B9)</label>
                <input type="number" min={0} step="0.01" value={pricePerKg} onChange={(e) => setPricePerKg(e.target.value)} className={cls} />
              </div>
            ) : (
              <div>
                <label className="block text-sm text-ds-ink-muted mb-1">Cost per unit (\u20B9)</label>
                <input type="number" min={0} step="0.01" value={costPerUnit} onChange={(e) => setCostPerUnit(e.target.value)} className={cls} />
              </div>
            )}
            <div>
              <label className="block text-sm text-ds-ink-muted mb-1">Total cost (\u20B9)</label>
              <input type="text" readOnly value={totalCost > 0 ? `\u20B9 ${totalCost.toLocaleString()}` : '—'} className={`${cls} opacity-60 cursor-not-allowed`} />
            </div>
          </div>
          {isBoardType && conversion && pricePerKg && (
            <p className="text-xs text-ds-ink-faint">WAC will be calculated per kg: (Current kg &times; Current WAC + {conversion.totalWeightKg.toFixed(2)} kg &times; \u20B9{pricePerKg}) / total kg</p>
          )}
        </div>

        {/* Batch & Pallet Tracking */}
        <div className="bg-ds-card rounded-lg border border-ds-line/50 p-4 space-y-3">
          <h3 className="text-ds-ink-muted text-sm font-medium">Batch & Pallet Tracking</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-ds-ink-muted mb-1">Lot / Pallet ID</label>
              <input type="text" value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} className={cls}
                placeholder={selectedMaterial ? `Auto: GRN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${selectedMaterial.materialCode.slice(0, 8)}` : 'Auto-generated if blank'} />
            </div>
            <div>
              <label className="block text-sm text-ds-ink-muted mb-1">Mill date</label>
              <input type="date" value={millDate} onChange={(e) => setMillDate(e.target.value)} className={cls} />
            </div>
            <div>
              <label className="block text-sm text-ds-ink-muted mb-1">Number of pallets</label>
              <input type="number" min={0} value={palletCount} onChange={(e) => setPalletCount(e.target.value)} className={cls} />
            </div>
            {conversion && Number(palletCount) > 0 && (
              <div className="flex items-end pb-2">
                <span className="text-xs text-ds-ink-muted">
                  ~{Math.round(conversion.totalSheets / Number(palletCount)).toLocaleString()} sheets/pallet
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Submit */}
        <button type="submit" disabled={submitting || (toleranceWarning != null && !approvalOverride)}
          className="w-full py-2.5 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:bg-ds-line/30 disabled:cursor-not-allowed text-primary-foreground font-medium text-sm">
          {submitting ? 'Posting...' : 'Post GRN'}
        </button>
      </form>
    </div>
  )
}
