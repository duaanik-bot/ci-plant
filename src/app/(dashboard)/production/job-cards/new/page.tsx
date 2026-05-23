'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from '@/store/toastStore'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'

type PurchaseOrder = {
  id: string
  poNumber: string
  poDate?: string
  customer: { id: string; name: string }
  lineItems: {
    id: string
    cartonName: string
    cartonSize: string | null
    quantity: number
    gsm?: number | null
    paperType?: string | null
    coatingType?: string | null
    embossingLeafing?: string | null
    setNumber: string | null
    jobCardNumber: number | null
  }[]
}

type LineDetail = {
  id: string
  cartonName: string
  cartonSize: string | null
  quantity: number
  gsm: number | null
  paperType: string | null
  coatingType: string | null
  embossingLeafing: string | null
  po: { poNumber: string; poDate: string; customer: { name: string } }
  materialQueue?: {
    boardType?: string | null
    gsm?: number | null
    ups?: number | null
    sheetLengthMm?: number | null
    sheetWidthMm?: number | null
    totalSheets?: number | null
  } | null
  specOverrides?: Record<string, unknown> | null
}

export default function NewJobCardPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [poId, setPoId] = useState('')
  const [lineId, setLineId] = useState('')
  const [lineDetail, setLineDetail] = useState<LineDetail | null>(null)
  const [requiredSheets, setRequiredSheets] = useState('')
  const [wastageSheets, setWastageSheets] = useState('150')
  const [assignedOperator, setAssignedOperator] = useState('')
  const [machineId, setMachineId] = useState('')
  const [shift, setShift] = useState('A')
  const [priority, setPriority] = useState('Normal')
  const [remarks, setRemarks] = useState('')
  const [internalNotes, setInternalNotes] = useState('')

  const poSearch = useAutoPopulate<PurchaseOrder>({
    storageKey: 'jobcard-po',
    search: async (query: string) => {
      const res = await fetch('/api/purchase-orders')
      const data = (await res.json()) as PurchaseOrder[]
      if (!Array.isArray(data)) return []
      const q = query.toLowerCase()
      return data.filter(
        (p) => p.poNumber.toLowerCase().includes(q) || (p.customer?.name || '').toLowerCase().includes(q),
      )
    },
    getId: (p) => p.id,
    getLabel: (p) => `${p.poNumber} — ${p.customer?.name || ''}`,
  })

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
  }, [searchParams])

  useEffect(() => {
    if (!lineId) return setLineDetail(null)
    fetch(`/api/planning/po-lines/${lineId}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setLineDetail(d?.id ? d : null))
      .catch(() => setLineDetail(null))
  }, [lineId])

  const selectedPo = useMemo(() => pos.find((p) => p.id === poId) || null, [pos, poId])
  const availableLines = useMemo(() => (selectedPo ? selectedPo.lineItems.filter((l) => !l.jobCardNumber) : []), [selectedPo])
  const selectedLine = useMemo(() => availableLines.find((l) => l.id === lineId) || null, [availableLines, lineId])

  useEffect(() => {
    if (!selectedLine) return
    const qty = Number(selectedLine.quantity || 0)
    const ups = Number(lineDetail?.materialQueue?.ups || 1)
    const base = qty > 0 ? Math.ceil(qty / Math.max(1, ups)) : 0
    const wastage = Math.max(0, Number(wastageSheets || 0))
    setRequiredSheets(String(base + wastage))
  }, [selectedLine?.id, lineDetail?.materialQueue?.ups, wastageSheets])

  const autoSummary = useMemo(() => {
    const mq = lineDetail?.materialQueue
    const sheetSize =
      mq?.sheetLengthMm && mq?.sheetWidthMm ? `${mq.sheetLengthMm}x${mq.sheetWidthMm}` : lineDetail?.cartonSize || '-'
    return {
      product: lineDetail?.cartonName || selectedLine?.cartonName || '-',
      client: lineDetail?.po?.customer?.name || selectedPo?.customer?.name || '-',
      poNo: lineDetail?.po?.poNumber || selectedPo?.poNumber || '-',
      poDate: lineDetail?.po?.poDate ? new Date(lineDetail.po.poDate).toLocaleDateString() : '-',
      qty: lineDetail?.quantity || selectedLine?.quantity || 0,
      size: lineDetail?.cartonSize || selectedLine?.cartonSize || '-',
      sheetSize,
      ups: mq?.ups || '-',
      gsm: lineDetail?.gsm ?? selectedLine?.gsm ?? '-',
      board: lineDetail?.paperType || selectedLine?.paperType || mq?.boardType || '-',
      coating: lineDetail?.coatingType || selectedLine?.coatingType || '-',
      emboss: lineDetail?.embossingLeafing || selectedLine?.embossingLeafing || '-',
      materialCode: '-',
      reserved: 0,
      shortage: 0,
      prStatus: 'not_created',
    }
  }, [lineDetail, selectedLine, selectedPo])

  const createJobCard = async (asDraft: boolean) => {
    if (!lineId) return toast.error('Select PO line item')
    if (!requiredSheets || Number(requiredSheets) <= 0) return toast.error('Required sheets must be > 0')
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
          machineId: machineId || undefined,
          orchestrationSource: 'manual_job_card_entry',
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create job card')
      if (asDraft) {
        await fetch(`/api/job-cards/${json.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'draft',
            postPressRouting: {
              shift,
              priority,
              remarks,
              internalNotes,
            },
          }),
        })
      }
      toast.success(asDraft ? 'Draft saved' : 'Job card created')
      router.push('/production/job-cards')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-4 text-ds-ink-muted">Loading…</div>

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-semibold">Add Job Card</h1>

      <section className="rounded-ds-lg bg-ds-card p-4 space-y-3 shadow-ds-depth-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ds-ink-muted">A. Source Selection</h2>
        <div className="grid md:grid-cols-2 gap-3">
          <MasterSearchSelect
            label="Purchase Order"
            required
            query={poSearch.query}
            onQueryChange={(value) => {
              poSearch.setQuery(value)
              setPoId('')
              setLineId('')
            }}
            loading={poSearch.loading}
            options={poSearch.options}
            lastUsed={poSearch.lastUsed}
            onSelect={(p) => {
              poSearch.select(p)
              setPoId(p.id)
              setLineId('')
            }}
            getOptionLabel={(p) => p.poNumber}
            getOptionMeta={(p) => p.customer?.name ?? ''}
            placeholder="Type PO number or customer..."
            recentLabel="Recent purchase orders"
            loadingMessage="Searching purchase orders..."
            emptyMessage="No purchase order found."
          />
          <div>
            <label className="block text-ds-ink-muted mb-1">PO line item*</label>
            <select
              value={lineId}
              onChange={(e) => setLineId(e.target.value)}
              className="w-full px-3 py-2 rounded-ds-md bg-background text-foreground"
              disabled={!selectedPo}
            >
              <option value="">Select line…</option>
              {availableLines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.cartonName} · Qty {l.quantity}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="rounded-ds-lg bg-ds-card p-4 space-y-3 shadow-ds-depth-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ds-ink-muted">B. Auto-filled Job Summary</h2>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          {[
            ['Product', autoSummary.product],
            ['Client', autoSummary.client],
            ['PO No', autoSummary.poNo],
            ['PO Date', autoSummary.poDate],
            ['Qty', String(autoSummary.qty)],
            ['Size', autoSummary.size],
            ['Sheet Size', autoSummary.sheetSize],
            ['UPS', String(autoSummary.ups)],
            ['GSM', String(autoSummary.gsm)],
            ['Board/Material', autoSummary.board],
          ].map(([k, v]) => (
            <div key={k}>
              <label className="block text-ds-ink-muted mb-1">{k}</label>
              <input value={v} readOnly className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated text-foreground" />
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-ds-lg bg-ds-card p-4 space-y-3 shadow-ds-depth-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ds-ink-muted">C. Material & Sheet Config</h2>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          <div><label className="block text-ds-ink-muted mb-1">Material Code</label><input readOnly value={autoSummary.materialCode} className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated" /></div>
          <div><label className="block text-ds-ink-muted mb-1">Parent Board Size</label><input readOnly value={autoSummary.sheetSize} className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated" /></div>
          <div><label className="block text-ds-ink-muted mb-1">Required Sheets</label><input value={requiredSheets} onChange={(e) => setRequiredSheets(e.target.value)} className="w-full px-3 py-2 rounded-ds-md bg-background" /></div>
          <div><label className="block text-ds-ink-muted mb-1">Wastage Sheets</label><input value={wastageSheets} onChange={(e) => setWastageSheets(e.target.value)} className="w-full px-3 py-2 rounded-ds-md bg-background" /></div>
          <div><label className="block text-ds-ink-muted mb-1">Reserved Sheets</label><input readOnly value={autoSummary.reserved} className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated" /></div>
          <div><label className="block text-ds-ink-muted mb-1">Shortage Sheets</label><input readOnly value={autoSummary.shortage} className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated" /></div>
          <div><label className="block text-ds-ink-muted mb-1">PR Status</label><input readOnly value={autoSummary.prStatus} className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated" /></div>
        </div>
      </section>

      <section className="rounded-ds-lg bg-ds-card p-4 space-y-3 shadow-ds-depth-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ds-ink-muted">D/E. Printing & Finishing + Machine Setup</h2>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          <div><label className="block text-ds-ink-muted mb-1">Coating</label><input readOnly value={autoSummary.coating} className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated" /></div>
          <div><label className="block text-ds-ink-muted mb-1">Emboss/Leaf</label><input readOnly value={autoSummary.emboss} className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated" /></div>
          <div><label className="block text-ds-ink-muted mb-1">Printing machine</label><input value={machineId} onChange={(e) => setMachineId(e.target.value)} placeholder="Machine ID (optional)" className="w-full px-3 py-2 rounded-ds-md bg-background" /></div>
          <div><label className="block text-ds-ink-muted mb-1">Operator</label><input value={assignedOperator} onChange={(e) => setAssignedOperator(e.target.value)} className="w-full px-3 py-2 rounded-ds-md bg-background" /></div>
          <div><label className="block text-ds-ink-muted mb-1">Shift</label><select value={shift} onChange={(e) => setShift(e.target.value)} className="w-full px-3 py-2 rounded-ds-md bg-background"><option>A</option><option>B</option><option>C</option></select></div>
          <div><label className="block text-ds-ink-muted mb-1">Priority</label><select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full px-3 py-2 rounded-ds-md bg-background"><option>Low</option><option>Normal</option><option>High</option></select></div>
          <div className="md:col-span-2"><label className="block text-ds-ink-muted mb-1">Remarks</label><input value={remarks} onChange={(e) => setRemarks(e.target.value)} className="w-full px-3 py-2 rounded-ds-md bg-background" /></div>
          <div className="md:col-span-4"><label className="block text-ds-ink-muted mb-1">Internal notes</label><textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} className="w-full px-3 py-2 rounded-ds-md bg-background min-h-[90px]" /></div>
        </div>
      </section>

      <section className="rounded-ds-lg bg-ds-card p-4 space-y-3 shadow-ds-depth-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ds-ink-muted">F. Media / Files</h2>
        <p className="text-sm text-ds-ink-muted">Artwork file / Dieline / Shade card will be inherited when pushed from AW Queue. Manual upload can be added later.</p>
      </section>

      <div className="sticky bottom-2 z-20 rounded-ds-lg bg-background p-3 flex justify-end gap-2 shadow-ds-depth-sm">
        <button type="button" onClick={() => router.push('/production/job-cards')} className="px-4 py-2 rounded-ds-md bg-ds-elevated text-sm">Cancel</button>
        <button type="button" disabled={saving} onClick={() => void createJobCard(true)} className="px-4 py-2 rounded-ds-md bg-ds-elevated text-sm">Save Draft</button>
        <button type="button" disabled={saving} onClick={() => void createJobCard(false)} className="px-4 py-2 rounded-ds-md bg-[var(--brand-primary)] text-primary-foreground text-sm">{saving ? 'Saving…' : 'Create Job Card'}</button>
      </div>
    </div>
  )
}

