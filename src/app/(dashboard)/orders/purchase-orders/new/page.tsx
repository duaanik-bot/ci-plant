'use client'

import { useRef, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  COATING_TYPES,
  EMBOSSING_TYPES,
  PAPER_TYPES,
  BOARD_GRADES,
  FOIL_TYPES,
} from '@/lib/constants'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

type Customer = {
  id: string
  name: string
  gstNumber?: string | null
  contactName?: string | null
  contactPhone?: string | null
  email?: string | null
  address?: string | null
}

type CartonOption = {
  id: string
  cartonName: string
  customerId: string
  cartonSize: string
  boardGrade?: string | null
  gsm?: number | null
  paperType?: string | null
  rate?: number | null
  gstPct: number
  coatingType?: string | null
  embossingLeafing?: string | null
  foilType?: string | null
  artworkCode?: string | null
  backPrint?: string | null
  dyeId?: string | null
}

type Line = {
  cartonId: string
  cartonName: string
  cartonSize: string
  quantity: string
  artworkCode: string
  backPrint: string
  ups: string
  wastagePct: string
  rate: string
  gstPct: string
  gsm: string
  coatingType: string
  embossingLeafing: string
  paperType: string
  boardGrade: string
  foilType: string
  remarks: string
}

const defaultLine = (): Line => ({
  cartonId: '',
  cartonName: '',
  cartonSize: '',
  quantity: '',
  artworkCode: '',
  backPrint: 'No',
  ups: '1',
  wastagePct: '5',
  rate: '',
  gstPct: '12',
  gsm: '',
  coatingType: '',
  embossingLeafing: '',
  paperType: '',
  boardGrade: '',
  foilType: '',
  remarks: '',
})

function requiredSheets(qty: number, ups: number): number {
  if (ups < 1) return 0
  return Math.ceil(qty / ups)
}

function totalSheets(req: number, wastagePct: number): number {
  return Math.ceil(req * (1 + wastagePct / 100))
}

function lineAmount(rate: number, totalSh: number, gstPct: number): { beforeGst: number; gst: number } {
  const beforeGst = (rate / 1000) * totalSh
  const gst = beforeGst * (gstPct / 100)
  return { beforeGst, gst }
}

export default function NewPurchaseOrderPage() {
  const router = useRouter()
  const customerIdRef = useRef('')
  const [customerId, setCustomerId] = useState('')
  const [poDate, setPoDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [deliveryRequiredBy, setDeliveryRequiredBy] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [remarks, setRemarks] = useState('')
  const [lines, setLines] = useState<Line[]>([defaultLine()])
  const [saving, setSaving] = useState(false)
  const [activeCartonLineIndex, setActiveCartonLineIndex] = useState<number | null>(null)

  const [qcCustomerOpen, setQcCustomerOpen] = useState(false)
  const [qcCustomer, setQcCustomer] = useState({
    name: '',
    gstNumber: '',
    contactName: '',
    contactPhone: '',
    email: '',
    address: '',
    requiresArtworkApproval: true,
  })
  const [qcErrors, setQcErrors] = useState<Record<string, string>>({})
  const [qcSaving, setQcSaving] = useState(false)

  const [qcCartonOpen, setQcCartonOpen] = useState(false)
  const [qcCarton, setQcCarton] = useState({
    cartonName: '',
    sizeL: '',
    sizeW: '',
    sizeH: '',
    rate: '',
    gstPct: '12',
    boardGrade: '',
    gsm: '',
    paperType: '',
    coatingType: '',
    embossingLeafing: '',
    foilType: '',
  })
  const [qcCartonErrors, setQcCartonErrors] = useState<Record<string, string>>({})
  const [qcCartonSaving, setQcCartonSaving] = useState(false)

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  customerIdRef.current = customerId

  const customerSearch = useAutoPopulate<Customer>({
    storageKey: 'po-customer',
    search: async (query: string) => {
      const res = await fetch('/api/customers')
      const data = (await res.json()) as Customer[]
      const q = query.toLowerCase()
      return data.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.contactName ?? '').toLowerCase().includes(q),
      )
    },
    getId: (c) => c.id,
    getLabel: (c) => c.name,
  })

  const cartonSearch = useAutoPopulate<CartonOption>({
    storageKey: 'po-carton',
    search: async (query: string) => {
      const cid = customerIdRef.current
      const url = `/api/cartons?${cid ? `customerId=${cid}&` : ''}q=${encodeURIComponent(query)}`
      const res = await fetch(url)
      return res.json()
    },
    getId: (c) => c.id,
    getLabel: (c) => c.cartonName,
  })

  const applyCustomer = (c: Customer) => {
    customerSearch.select(c)
    setCustomerId(c.id)
  }

  const applyCartonToLine = (idx: number, c: CartonOption) => {
    cartonSearch.select(c)
    updateLine(idx, {
      cartonId: c.id,
      cartonName: c.cartonName,
      cartonSize: c.cartonSize || '',
      artworkCode: c.artworkCode || '',
      backPrint: c.backPrint || 'No',
      rate: c.rate != null ? String(c.rate) : '',
      gsm: c.gsm != null ? String(c.gsm) : '',
      gstPct: String(c.gstPct ?? 12),
      coatingType: c.coatingType || '',
      embossingLeafing: c.embossingLeafing || '',
      paperType: c.paperType || '',
      boardGrade: c.boardGrade || '',
      foilType: c.foilType || '',
    })
    setActiveCartonLineIndex(null)
  }

  const updateLine = (idx: number, patch: Partial<Line>) => {
    setLines((prev) => prev.map((ln, i) => (i === idx ? { ...ln, ...patch } : ln)))
  }

  const addLine = () => {
    setLines((prev) => [...prev, defaultLine()])
  }

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx))
  }

  const validLines = lines.filter(
    (l) => l.cartonName.trim() && l.quantity.trim() && Number(l.quantity) > 0,
  )
  const subtotal = validLines.reduce((sum, l) => {
    const qty = Number(l.quantity) || 0
    const ups = Math.max(1, Number(l.ups) || 1)
    const wastage = Number(l.wastagePct) || 0
    const req = requiredSheets(qty, ups)
    const tot = totalSheets(req, wastage)
    const rate = Number(l.rate) || 0
    const gstPct = Number(l.gstPct) || 0
    const { beforeGst } = lineAmount(rate, tot, gstPct)
    return sum + beforeGst
  }, 0)
  const totalGst = validLines.reduce((sum, l) => {
    const qty = Number(l.quantity) || 0
    const ups = Math.max(1, Number(l.ups) || 1)
    const wastage = Number(l.wastagePct) || 0
    const req = requiredSheets(qty, ups)
    const tot = totalSheets(req, wastage)
    const rate = Number(l.rate) || 0
    const gstPct = Number(l.gstPct) || 0
    const { gst } = lineAmount(rate, tot, gstPct)
    return sum + gst
  }, 0)
  const grandTotal = subtotal + totalGst
  const totalQty = validLines.reduce((s, l) => s + (Number(l.quantity) || 0), 0)
  const totalSheetsSum = validLines.reduce((s, l) => {
    const qty = Number(l.quantity) || 0
    const ups = Math.max(1, Number(l.ups) || 1)
    const wastage = Number(l.wastagePct) || 0
    return s + totalSheets(requiredSheets(qty, ups), wastage)
  }, 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const err: Record<string, string> = {}
    if (!customerId) err.customerId = 'Select a customer'
    if (validLines.length === 0) err.lines = 'Add at least one line with carton name and quantity'
    validLines.forEach((l, i) => {
      if (l.rate === '' || (Number(l.rate) < 0)) err[`line${i}_rate`] = 'Rate required'
    })
    setFieldErrors(err)
    if (Object.keys(err).length > 0) {
      toast.error('Please fix the errors below')
      return
    }
    setSaving(true)
    try {
      const combinedRemarks = [remarks, deliveryRequiredBy && `Delivery by: ${deliveryRequiredBy}`, paymentTerms && `Payment: ${paymentTerms}`]
        .filter(Boolean)
        .join('. ')
      const res = await fetch('/api/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId,
          poDate,
          remarks: combinedRemarks || undefined,
          lineItems: validLines.map((l) => {
            const qty = Number(l.quantity)
            const ups = Math.max(1, Number(l.ups) || 1)
            const wastage = Number(l.wastagePct) || 0
            const req = requiredSheets(qty, ups)
            const tot = totalSheets(req, wastage)
            return {
              cartonId: l.cartonId || undefined,
              cartonName: l.cartonName.trim(),
              cartonSize: l.cartonSize.trim() || undefined,
              quantity: qty,
              artworkCode: l.artworkCode.trim() || undefined,
              backPrint: l.backPrint || 'No',
              rate: l.rate ? Number(l.rate) : undefined,
              gsm: l.gsm ? Number(l.gsm) : undefined,
              gstPct: l.gstPct ? Number(l.gstPct) : undefined,
              coatingType: l.coatingType || undefined,
              embossingLeafing: l.embossingLeafing || undefined,
              paperType: l.paperType || undefined,
              remarks: l.remarks.trim() || undefined,
              specOverrides: {
                ups,
                wastagePct: wastage,
                requiredSheets: req,
                totalSheets: tot,
                boardGrade: l.boardGrade.trim() || undefined,
                foilType: l.foilType.trim() || undefined,
              },
            }
          }),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to save PO')
      toast.success(`PO saved. ${validLines.length} item(s) added to Planning queue.`)
      router.push('/orders/purchase-orders')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const submitQuickCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (!qcCustomer.name.trim()) next.name = 'Name is required'
    setQcErrors(next)
    if (Object.keys(next).length) return
    setQcSaving(true)
    try {
      const res = await fetch('/api/masters/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: qcCustomer.name,
          gstNumber: qcCustomer.gstNumber || undefined,
          contactName: qcCustomer.contactName || undefined,
          contactPhone: qcCustomer.contactPhone || undefined,
          email: qcCustomer.email || undefined,
          address: qcCustomer.address || undefined,
          requiresArtworkApproval: qcCustomer.requiresArtworkApproval,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error ?? 'Failed to create customer')
        return
      }
      setQcCustomerOpen(false)
      applyCustomer(data as Customer)
      toast.success('Customer created')
    } catch {
      toast.error('Failed to create customer')
    } finally {
      setQcSaving(false)
    }
  }

  const submitQuickCreateCarton = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!customerId) {
      toast.error('Select a customer first')
      return
    }
    const next: Record<string, string> = {}
    if (!qcCarton.cartonName.trim()) next.cartonName = 'Carton name is required'
    setQcCartonErrors(next)
    if (Object.keys(next).length) return
    setQcCartonSaving(true)
    try {
      const body: Record<string, unknown> = {
        cartonName: qcCarton.cartonName.trim(),
        customerId,
        rate: qcCarton.rate ? Number(qcCarton.rate) : undefined,
        gstPct: qcCarton.gstPct ? Number(qcCarton.gstPct) : 12,
        boardGrade: qcCarton.boardGrade || undefined,
        gsm: qcCarton.gsm ? Number(qcCarton.gsm) : undefined,
        paperType: qcCarton.paperType || undefined,
        coatingType: qcCarton.coatingType || undefined,
        embossingLeafing: qcCarton.embossingLeafing || undefined,
        foilType: qcCarton.foilType || undefined,
      }
      const l = qcCarton.sizeL ? Number(qcCarton.sizeL) : null
      const w = qcCarton.sizeW ? Number(qcCarton.sizeW) : null
      const h = qcCarton.sizeH ? Number(qcCarton.sizeH) : null
      if (l != null && l > 0) body.finishedLength = l
      if (w != null && w > 0) body.finishedWidth = w
      if (h != null && h > 0) body.finishedHeight = h
      const res = await fetch('/api/masters/cartons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error ?? 'Failed to create carton')
        return
      }
      const created = data as CartonOption & { finishedLength?: number; finishedWidth?: number; finishedHeight?: number }
      const cartonSizeStr =
        created.finishedLength != null && created.finishedWidth != null && created.finishedHeight != null
          ? `${created.finishedLength}×${created.finishedWidth}×${created.finishedHeight}`
          : ''
      const formatted: CartonOption = {
        id: created.id,
        cartonName: created.cartonName,
        customerId: created.customerId,
        cartonSize: cartonSizeStr,
        boardGrade: (created.boardGrade ?? qcCarton.boardGrade) || null,
        gsm: created.gsm ?? (qcCarton.gsm ? Number(qcCarton.gsm) : null),
        paperType: (created.paperType ?? qcCarton.paperType) || null,
        rate: created.rate ?? (qcCarton.rate ? Number(qcCarton.rate) : null),
        gstPct: created.gstPct ?? Number(qcCarton.gstPct),
        coatingType: (created.coatingType ?? qcCarton.coatingType) || null,
        embossingLeafing: (created.embossingLeafing ?? qcCarton.embossingLeafing) || null,
        foilType: (created.foilType ?? qcCarton.foilType) || null,
        artworkCode: created.artworkCode ?? null,
        backPrint: created.backPrint ?? 'No',
        dyeId: created.dyeId ?? null,
      }
      if (activeCartonLineIndex != null) {
        applyCartonToLine(activeCartonLineIndex, formatted)
      }
      setQcCartonOpen(false)
      setActiveCartonLineIndex(null)
      setQcCarton({ cartonName: '', sizeL: '', sizeW: '', sizeH: '', rate: '', gstPct: '12', boardGrade: '', gsm: '', paperType: '', coatingType: '', embossingLeafing: '', foilType: '' })
      toast.success('Carton created')
    } catch {
      toast.error('Failed to create carton')
    } finally {
      setQcCartonSaving(false)
    }
  }

  const inputCls = 'w-full px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-xs'
  const inputErr = 'border-red-500'

  return (
    <form onSubmit={handleSubmit} className="p-4 max-w-[1600px] mx-auto space-y-4">
      <h1 className="text-xl font-bold text-amber-400">New Purchase Order</h1>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm">
        <div>
          <label className="block text-slate-400 mb-1">
            Customer<span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={customerSearch.query}
            onChange={(e) => {
              customerSearch.setQuery(e.target.value)
              setCustomerId('')
            }}
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white ${fieldErrors.customerId ? 'border-red-500' : 'border-slate-600'}`}
            placeholder="Type customer name…"
          />
          {customerSearch.loading && <p className="text-[11px] text-slate-400 mt-1">Searching…</p>}
          {customerSearch.options.length > 0 && (
            <div className="mt-1 rounded border border-slate-700 bg-slate-900 max-h-40 overflow-y-auto text-xs">
              {customerSearch.options.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => applyCustomer(c)}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-800 text-slate-100"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {customerSearch.lastUsed.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {customerSearch.lastUsed.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => applyCustomer(c)}
                  className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-200 border border-slate-600 hover:border-amber-500"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setQcCustomerOpen(true)} className="mt-1 text-xs text-amber-400 hover:underline">
            Create New Customer
          </button>
          {fieldErrors.customerId && <p className="text-xs text-red-400 mt-1">{fieldErrors.customerId}</p>}
        </div>
        <div>
          <label className="block text-slate-400 mb-1">PO date*</label>
          <input
            type="date"
            value={poDate}
            onChange={(e) => setPoDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Delivery required by</label>
          <input
            type="date"
            value={deliveryRequiredBy}
            onChange={(e) => setDeliveryRequiredBy(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Payment terms</label>
          <input
            type="text"
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            placeholder="e.g. 30 days"
          />
        </div>
        <div className="md:col-span-2 lg:col-span-4">
          <label className="block text-slate-400 mb-1">Remarks</label>
          <input
            type="text"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div className="md:col-span-2 lg:col-span-4 text-slate-400 text-sm">
          PO value (computed): ₹ {grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs space-y-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-slate-200 font-semibold text-sm">Line items</h2>
          <button type="button" onClick={addLine} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs">
            + Add line
          </button>
        </div>
        {fieldErrors.lines && <p className="text-red-400 text-xs">{fieldErrors.lines}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[1200px]">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="px-2 py-1">Carton name</th>
                <th className="px-2 py-1">Size</th>
                <th className="px-2 py-1">Qty*</th>
                <th className="px-2 py-1">Artwork</th>
                <th className="px-2 py-1">Back</th>
                <th className="px-2 py-1">UPS</th>
                <th className="px-2 py-1">Req sheets</th>
                <th className="px-2 py-1">Wastage%</th>
                <th className="px-2 py-1">Total sheets</th>
                <th className="px-2 py-1">Rate</th>
                <th className="px-2 py-1">GST%</th>
                <th className="px-2 py-1">Amount</th>
                <th className="px-2 py-1">Board</th>
                <th className="px-2 py-1">GSM</th>
                <th className="px-2 py-1">Paper</th>
                <th className="px-2 py-1">Coating</th>
                <th className="px-2 py-1">Emboss</th>
                <th className="px-2 py-1">Foil</th>
                <th className="px-2 py-1">Remarks</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {lines.map((ln, idx) => {
                const qty = Number(ln.quantity) || 0
                const ups = Math.max(1, Number(ln.ups) || 1)
                const wastage = Number(ln.wastagePct) || 0
                const req = requiredSheets(qty, ups)
                const tot = totalSheets(req, wastage)
                const rate = Number(ln.rate) || 0
                const gstPct = Number(ln.gstPct) || 0
                const { beforeGst, gst } = lineAmount(rate, tot, gstPct)
                const amount = beforeGst + gst
                const isActiveCarton = activeCartonLineIndex === idx
                return (
                  <tr key={idx} className="border-t border-slate-800">
                    <td className="px-2 py-1 align-top relative">
                      <input
                        type="text"
                        value={isActiveCarton ? cartonSearch.query : ln.cartonName}
                        onChange={(e) => {
                          setActiveCartonLineIndex(idx)
                          cartonSearch.setQuery(e.target.value)
                        }}
                        onFocus={() => setActiveCartonLineIndex(idx)}
                        className={`min-w-[120px] ${inputCls} ${!ln.cartonName && fieldErrors.lines ? inputErr : ''}`}
                        placeholder="Search carton…"
                      />
                      {isActiveCarton && (
                        <>
                          {cartonSearch.loading && <span className="absolute right-2 top-1.5 text-slate-500 text-[10px]">…</span>}
                          {cartonSearch.options.length > 0 && (
                            <div className="absolute z-10 left-0 top-full mt-0.5 rounded border border-slate-600 bg-slate-900 shadow-lg max-h-32 overflow-y-auto min-w-[200px]">
                              {cartonSearch.options.map((c) => (
                                <button
                                  key={c.id}
                                  type="button"
                                  onClick={() => applyCartonToLine(idx, c)}
                                  className="w-full text-left px-2 py-1.5 hover:bg-slate-800 text-slate-100 text-xs"
                                >
                                  {c.cartonName} {c.cartonSize ? `(${c.cartonSize})` : ''}
                                </button>
                              ))}
                            </div>
                          )}
                          {customerId && cartonSearch.query.length >= 2 && !cartonSearch.loading && (
                            <button
                              type="button"
                              onClick={() => {
                                setQcCarton((prev) => ({ ...prev, cartonName: cartonSearch.query.trim() }))
                                setQcCartonOpen(true)
                              }}
                              className="mt-1 text-[10px] text-amber-400 hover:underline"
                            >
                              Create new carton
                            </button>
                          )}
                        </>
                      )}
                      {!ln.cartonId && ln.cartonName.trim() && (
                        <span className="ml-1 text-[10px] text-amber-400">(new)</span>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={ln.cartonSize}
                        onChange={(e) => updateLine(idx, { cartonSize: e.target.value })}
                        className={`w-24 ${inputCls}`}
                        placeholder="L×W×H"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        min={1}
                        value={ln.quantity}
                        onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                        className={`w-16 ${inputCls} ${fieldErrors[`line${idx}_rate`] ? inputErr : ''}`}
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input type="text" value={ln.artworkCode} onChange={(e) => updateLine(idx, { artworkCode: e.target.value })} className={`w-20 ${inputCls}`} />
                    </td>
                    <td className="px-2 py-1">
                      <select value={ln.backPrint} onChange={(e) => updateLine(idx, { backPrint: e.target.value })} className={inputCls}>
                        <option value="No">No</option>
                        <option value="Yes">Yes</option>
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" min={1} value={ln.ups} onChange={(e) => updateLine(idx, { ups: e.target.value })} className={`w-14 ${inputCls}`} />
                    </td>
                    <td className="px-2 py-1 text-slate-400 tabular-nums">{req}</td>
                    <td className="px-2 py-1">
                      <input type="number" min={0} step={0.5} value={ln.wastagePct} onChange={(e) => updateLine(idx, { wastagePct: e.target.value })} className={`w-14 ${inputCls}`} />
                    </td>
                    <td className="px-2 py-1 text-slate-300 tabular-nums">{tot}</td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={ln.rate}
                        onChange={(e) => updateLine(idx, { rate: e.target.value })}
                        className={`w-20 ${inputCls} ${fieldErrors[`line${idx}_rate`] ? inputErr : ''}`}
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" min={0} max={28} value={ln.gstPct} onChange={(e) => updateLine(idx, { gstPct: e.target.value })} className={`w-14 ${inputCls}`} />
                    </td>
                    <td className="px-2 py-1 text-slate-300 tabular-nums">{amount.toFixed(2)}</td>
                    <td className="px-2 py-1">
                      <select value={ln.boardGrade} onChange={(e) => updateLine(idx, { boardGrade: e.target.value })} className={inputCls}>
                        <option value="">—</option>
                        {BOARD_GRADES.map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" value={ln.gsm} onChange={(e) => updateLine(idx, { gsm: e.target.value })} className={`w-16 ${inputCls}`} />
                    </td>
                    <td className="px-2 py-1">
                      <select value={ln.paperType} onChange={(e) => updateLine(idx, { paperType: e.target.value })} className={inputCls}>
                        <option value="">—</option>
                        {PAPER_TYPES.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <select value={ln.coatingType} onChange={(e) => updateLine(idx, { coatingType: e.target.value })} className={inputCls}>
                        <option value="">—</option>
                        {COATING_TYPES.filter((c) => c !== 'None').map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <select value={ln.embossingLeafing} onChange={(e) => updateLine(idx, { embossingLeafing: e.target.value })} className={inputCls}>
                        <option value="">—</option>
                        {EMBOSSING_TYPES.filter((e) => e !== 'None').map((x) => (
                          <option key={x} value={x}>{x}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <select value={ln.foilType} onChange={(e) => updateLine(idx, { foilType: e.target.value })} className={inputCls}>
                        <option value="">—</option>
                        {FOIL_TYPES.filter((f) => f !== 'None').map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <input type="text" value={ln.remarks} onChange={(e) => updateLine(idx, { remarks: e.target.value })} className={`min-w-[80px] ${inputCls}`} />
                    </td>
                    <td className="px-2 py-1">
                      {lines.length > 1 && (
                        <button type="button" onClick={() => removeLine(idx)} className="text-red-400 hover:text-red-300">
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot className="bg-slate-800 text-slate-200 font-medium">
              <tr>
                <td colSpan={2} className="px-2 py-2">Total</td>
                <td className="px-2 py-2 tabular-nums">{totalQty}</td>
                <td colSpan={5} />
                <td className="px-2 py-2 tabular-nums">{totalSheetsSum}</td>
                <td colSpan={2} />
                <td className="px-2 py-2 tabular-nums">Subtotal ₹ {subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                <td colSpan={4} />
                <td className="px-2 py-2 tabular-nums">GST ₹ {totalGst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                <td className="px-2 py-2 tabular-nums">Grand total ₹ {grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => router.push('/orders/purchase-orders')} className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium">
          {saving ? 'Saving…' : 'Save PO'}
        </button>
      </div>

      <SlideOverPanel title="Quick Create Customer" isOpen={qcCustomerOpen} onClose={() => setQcCustomerOpen(false)}>
        <form onSubmit={submitQuickCreateCustomer} className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Name<span className="text-red-400">*</span></label>
            <input
              type="text"
              value={qcCustomer.name}
              onChange={(e) => setQcCustomer((prev) => ({ ...prev, name: e.target.value }))}
              className={`w-full px-3 py-2 rounded bg-slate-800 border ${qcErrors.name ? 'border-red-500' : 'border-slate-600'} text-white`}
            />
            {qcErrors.name && <p className="text-xs text-red-400 mt-1">{qcErrors.name}</p>}
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">GST</label>
            <input type="text" value={qcCustomer.gstNumber} onChange={(e) => setQcCustomer((prev) => ({ ...prev, gstNumber: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Contact / Phone / Email / Address</label>
            <input type="text" value={qcCustomer.contactName} onChange={(e) => setQcCustomer((prev) => ({ ...prev, contactName: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white mb-1" placeholder="Contact" />
            <input type="text" value={qcCustomer.contactPhone} onChange={(e) => setQcCustomer((prev) => ({ ...prev, contactPhone: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white mb-1" placeholder="Phone" />
            <input type="email" value={qcCustomer.email} onChange={(e) => setQcCustomer((prev) => ({ ...prev, email: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white mb-1" placeholder="Email" />
            <textarea rows={2} value={qcCustomer.address} onChange={(e) => setQcCustomer((prev) => ({ ...prev, address: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white" placeholder="Address" />
          </div>
          <div className="flex items-center gap-2">
            <input id="qc-artwork" type="checkbox" checked={qcCustomer.requiresArtworkApproval} onChange={(e) => setQcCustomer((prev) => ({ ...prev, requiresArtworkApproval: e.target.checked }))} className="h-4 w-4 rounded border-slate-500 bg-slate-800" />
            <label htmlFor="qc-artwork" className="text-xs text-slate-300">Requires Artwork Approval</label>
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={qcSaving} className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium">Save Customer</button>
          </div>
        </form>
      </SlideOverPanel>

      <SlideOverPanel title="Quick Create Carton" isOpen={qcCartonOpen} onClose={() => { setQcCartonOpen(false); setActiveCartonLineIndex(null) }}>
        <form onSubmit={submitQuickCreateCarton} className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Carton name<span className="text-red-400">*</span></label>
            <input
              type="text"
              value={qcCarton.cartonName}
              onChange={(e) => setQcCarton((prev) => ({ ...prev, cartonName: e.target.value }))}
              className={`w-full px-3 py-2 rounded bg-slate-800 border ${qcCartonErrors.cartonName ? 'border-red-500' : 'border-slate-600'} text-white`}
            />
            {qcCartonErrors.cartonName && <p className="text-xs text-red-400 mt-1">{qcCartonErrors.cartonName}</p>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">L</label>
              <input type="number" step={0.01} value={qcCarton.sizeL} onChange={(e) => setQcCarton((prev) => ({ ...prev, sizeL: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">W</label>
              <input type="number" step={0.01} value={qcCarton.sizeW} onChange={(e) => setQcCarton((prev) => ({ ...prev, sizeW: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">H</label>
              <input type="number" step={0.01} value={qcCarton.sizeH} onChange={(e) => setQcCarton((prev) => ({ ...prev, sizeH: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Rate</label>
              <input type="number" step={0.01} value={qcCarton.rate} onChange={(e) => setQcCarton((prev) => ({ ...prev, rate: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">GST%</label>
              <input type="number" min={0} max={28} value={qcCarton.gstPct} onChange={(e) => setQcCarton((prev) => ({ ...prev, gstPct: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Board grade</label>
            <select value={qcCarton.boardGrade} onChange={(e) => setQcCarton((prev) => ({ ...prev, boardGrade: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white">
              <option value="">—</option>
              {BOARD_GRADES.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">GSM</label>
              <input type="number" value={qcCarton.gsm} onChange={(e) => setQcCarton((prev) => ({ ...prev, gsm: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Paper</label>
              <select value={qcCarton.paperType} onChange={(e) => setQcCarton((prev) => ({ ...prev, paperType: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white">
                <option value="">—</option>
                {PAPER_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Coating / Emboss / Foil</label>
            <select value={qcCarton.coatingType} onChange={(e) => setQcCarton((prev) => ({ ...prev, coatingType: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white mb-1">
              <option value="">—</option>
              {COATING_TYPES.filter((c) => c !== 'None').map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={qcCarton.embossingLeafing} onChange={(e) => setQcCarton((prev) => ({ ...prev, embossingLeafing: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white mb-1">
              <option value="">—</option>
              {EMBOSSING_TYPES.filter((x) => x !== 'None').map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select value={qcCarton.foilType} onChange={(e) => setQcCarton((prev) => ({ ...prev, foilType: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white">
              <option value="">—</option>
              {FOIL_TYPES.filter((f) => f !== 'None').map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={qcCartonSaving} className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium">Save Carton</button>
          </div>
        </form>
      </SlideOverPanel>
    </form>
  )
}
