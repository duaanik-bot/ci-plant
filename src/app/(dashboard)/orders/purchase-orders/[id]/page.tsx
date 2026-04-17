'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  BOARD_GRADES,
  PAPER_TYPES,
  COATING_TYPES,
  EMBOSSING_TYPES,
  FOIL_TYPES,
} from '@/lib/constants'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import {
  mapApiRowToPoCarton,
  usePoRecentCartons,
  type PoCartonCatalogItem,
} from '@/lib/po-carton-autocomplete'
import { Copy, FileText, Trash2 } from 'lucide-react'
import { paperSupplyIconMeta } from '@/lib/po-paper-supply-ui'
import { parseDeliveryYmdFromRemarks } from '@/lib/po-delivery-parse'

type Customer = {
  id: string
  name: string
  gstNumber?: string | null
  contactName?: string | null
  contactPhone?: string | null
  email?: string | null
  address?: string | null
}

type CartonOption = PoCartonCatalogItem

type Line = {
  id?: string
  dieMasterId?: string
  materialProcurementStatus?: string
  cartonId: string
  cartonName: string
  cartonSize: string
  quantity: string
  artworkCode: string
  backPrint: string
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

type CartonLookupFieldProps = {
  line: Line
  customerId: string
  customerCatalog: CartonOption[]
  catalogLoading: boolean
  error?: string
  onLineChange: (patch: Partial<Line>) => void
  onSelect: (carton: CartonOption) => void
  onCreate: (suggestedName: string) => void
}

const defaultLine = (): Line => ({
  dieMasterId: '',
  materialProcurementStatus: 'not_calculated',
  cartonId: '',
  cartonName: '',
  cartonSize: '',
  quantity: '',
  artworkCode: '',
  backPrint: 'No',
  wastagePct: '10',
  rate: '',
  gstPct: '5',
  gsm: '',
  coatingType: '',
  embossingLeafing: '',
  paperType: '',
  boardGrade: '',
  foilType: '',
  remarks: '',
})

function resetAutofillFields(line: Line, cartonName: string): Line {
  if (!line.cartonId) return { ...line, cartonName }
  return {
    ...line,
    dieMasterId: '',
    materialProcurementStatus: 'not_calculated',
    cartonId: '',
    cartonName,
    cartonSize: '',
    artworkCode: '',
    backPrint: 'No',
    wastagePct: '10',
    rate: '',
    gstPct: '5',
    gsm: '',
    coatingType: '',
    embossingLeafing: '',
    paperType: '',
    boardGrade: '',
    foilType: '',
  }
}

function lineAmount(rate: number, qty: number, gstPct: number): { beforeGst: number; gst: number } {
  const beforeGst = rate * qty
  const gst = beforeGst * (gstPct / 100)
  return { beforeGst, gst }
}

function deriveCartonDecorations(carton: CartonOption): Pick<Line, 'coatingType' | 'embossingLeafing' | 'foilType'> {
  let coatingType = carton.coatingType || ''
  let embossingLeafing = carton.embossingLeafing || ''
  let foilType = carton.foilType || ''

  if (carton.specialInstructions) {
    try {
      const parsed = JSON.parse(carton.specialInstructions) as {
        spotUvEnabled?: boolean
        embossingEnabled?: boolean
        leafingEnabled?: boolean
      }
      if (!coatingType && parsed.spotUvEnabled) coatingType = 'Full UV'
      if (!embossingLeafing) {
        if (parsed.embossingEnabled && parsed.leafingEnabled) embossingLeafing = 'Embossing + Leafing'
        else if (parsed.embossingEnabled) embossingLeafing = 'Embossing'
        else if (parsed.leafingEnabled) embossingLeafing = 'Leafing'
      }
      if (!foilType && parsed.leafingEnabled) foilType = 'Hot Gold'
    } catch {}
  }

  return { coatingType, embossingLeafing, foilType }
}

function CartonLookupField({
  line,
  customerId,
  customerCatalog,
  catalogLoading,
  error,
  onLineChange,
  onSelect,
  onCreate,
}: CartonLookupFieldProps) {
  const { lastUsed, pushRecent } = usePoRecentCartons(customerId || undefined)
  const cartonQuery = line.cartonName

  const filteredOptions = useMemo(() => {
    const q = cartonQuery.trim().toLowerCase()
    if (!q) return []
    return customerCatalog
      .filter(
        (c) =>
          c.cartonName.toLowerCase().includes(q) ||
          (c.artworkCode ?? '').toLowerCase().includes(q),
      )
      .slice(0, 200)
  }, [customerCatalog, cartonQuery])

  useEffect(() => {
    if (line.cartonId || !line.cartonName.trim() || catalogLoading) return
    const normalizedName = line.cartonName.trim().toLowerCase()
    const exactMatches = customerCatalog.filter(
      (c) => c.cartonName.trim().toLowerCase() === normalizedName,
    )
    if (exactMatches.length !== 1) return
    const [match] = exactMatches
    pushRecent(match)
    onSelect(match)
  }, [line.cartonId, line.cartonName, customerCatalog, catalogLoading, onSelect, pushRecent])

  return (
    <div className="min-w-[180px]">
      <MasterSearchSelect
        label="Carton name"
        hideLabel
        query={cartonQuery}
        onQueryChange={(value) => onLineChange(resetAutofillFields(line, value))}
        loading={false}
        options={filteredOptions}
        lastUsed={lastUsed}
        browseOptions={customerCatalog}
        browseOptionsLabel="Products for this customer"
        browseLoading={catalogLoading}
        browseEmptyMessage={
          customerId && !catalogLoading && customerCatalog.length === 0
            ? 'No carton found for this customer.'
            : null
        }
        onSelect={(carton) => {
          pushRecent(carton)
          onSelect(carton)
        }}
        getOptionLabel={(carton) => carton.cartonName}
        getOptionMeta={(carton) =>
          [
            carton.artworkCode ? `AW: ${carton.artworkCode}` : null,
            carton.cartonSize || null,
            carton.boardGrade || null,
            carton.gsm ? `${carton.gsm} GSM` : null,
            carton.rate != null ? `₹${Number(carton.rate).toLocaleString('en-IN')}` : null,
          ]
            .filter(Boolean)
            .join(' · ')
        }
        error={error}
        disabled={!customerId}
        placeholder={customerId ? 'Search or type carton...' : 'Select customer first'}
        emptyMessage={customerId ? 'No matching carton in master for this customer.' : 'Select customer first.'}
        recentLabel="Recent cartons"
        loadingMessage="Searching cartons..."
        emptyActionLabel={customerId && cartonQuery.trim() ? `Create "${cartonQuery.trim()}" as new carton` : undefined}
        onEmptyAction={() => {
          const suggestedName = cartonQuery.trim()
          if (suggestedName) onCreate(suggestedName)
        }}
        inputClassName="min-w-[260px] px-2 py-1 text-xs"
        dropdownClassName="min-w-[320px]"
      />
      {!line.cartonId && line.cartonName.trim() ? (
        <span className="mt-1 inline-block text-[10px] text-amber-400">Unsaved carton name</span>
      ) : null}
    </div>
  )
}

export default function EditPurchaseOrderPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string

  const [loading, setLoading] = useState(true)
  const [poNumber, setPoNumber] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [poDate, setPoDate] = useState('')
  const [deliveryRequiredBy, setDeliveryRequiredBy] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [remarks, setRemarks] = useState('')
  const [status, setStatus] = useState('draft')
  const [lines, setLines] = useState<Line[]>([defaultLine()])
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [activeCartonLineIndex, setActiveCartonLineIndex] = useState<number | null>(null)

  const [qcCartonOpen, setQcCartonOpen] = useState(false)
  const [qcCarton, setQcCarton] = useState({
    cartonName: '',
    artworkCode: '',
    sizeL: '',
    sizeW: '',
    sizeH: '',
    rate: '',
    gstPct: '5',
    boardGrade: '',
    gsm: '',
    paperType: '',
    coatingType: '',
    embossingLeafing: '',
    foilType: '',
  })
  const [qcCartonErrors, setQcCartonErrors] = useState<Record<string, string>>({})
  const [qcCartonSaving, setQcCartonSaving] = useState(false)
  const [customerCartons, setCustomerCartons] = useState<CartonOption[]>([])
  const [customerCartonsLoading, setCustomerCartonsLoading] = useState(false)

  useEffect(() => {
    if (!customerId) {
      setCustomerCartons([])
      setCustomerCartonsLoading(false)
      return
    }
    let cancelled = false
    setCustomerCartonsLoading(true)
    void (async () => {
      try {
        const res = await fetch(`/api/cartons?customerId=${encodeURIComponent(customerId)}&limit=4000`)
        const data = (await res.json()) as Record<string, unknown>[]
        if (cancelled) return
        if (!Array.isArray(data)) {
          setCustomerCartons([])
          return
        }
        setCustomerCartons(data.map(mapApiRowToPoCarton))
      } catch {
        if (!cancelled) setCustomerCartons([])
      } finally {
        if (!cancelled) setCustomerCartonsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [customerId])

  const customerSearch = useAutoPopulate<Customer>({
    storageKey: 'po-customer',
    search: async (query: string) => {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(query)}`)
      return (await res.json()) as Customer[]
    },
    getId: (c) => c.id,
    getLabel: (c) => c.name,
  })

  useEffect(() => {
    fetch(`/api/purchase-orders/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load PO')
        setPoNumber(data.poNumber || '')
        setCustomerId(data.customer?.id || '')
        setSelectedCustomer(data.customer || null)
        if (data.customer) {
          customerSearch.setQuery(data.customer.name)
        }
        setPoDate(data.poDate ? data.poDate.slice(0, 10) : '')
        setStatus(data.status || 'draft')
        setRemarks(data.remarks || '')
        const drb =
          data.deliveryRequiredBy != null
            ? String(data.deliveryRequiredBy).slice(0, 10)
            : parseDeliveryYmdFromRemarks(data.remarks) || ''
        setDeliveryRequiredBy(drb)
        // Map lineItems from API to Line type
        const mapped: Line[] = (data.lineItems || []).map((li: any) => {
          const specOverrides = li.specOverrides && typeof li.specOverrides === 'object' ? li.specOverrides : {}
          return {
            id: li.id,
            dieMasterId: li.dieMasterId || '',
            materialProcurementStatus: li.materialProcurementStatus || 'not_calculated',
            cartonId: li.cartonId || '',
            cartonName: li.cartonName || '',
            cartonSize: li.cartonSize || '',
            quantity: li.quantity != null ? String(li.quantity) : '',
            artworkCode: li.artworkCode || '',
            backPrint: li.backPrint || 'No',
            wastagePct: specOverrides.wastagePct != null ? String(specOverrides.wastagePct) : '10',
            rate: li.rate != null ? String(li.rate) : '',
            gstPct: li.gstPct != null ? String(li.gstPct) : '5',
            gsm: li.gsm != null ? String(li.gsm) : '',
            coatingType: li.coatingType || '',
            embossingLeafing: li.embossingLeafing || '',
            paperType: li.paperType || '',
            boardGrade: specOverrides.boardGrade || li.boardGrade || '',
            foilType: specOverrides.foilType || li.foilType || '',
            remarks: li.remarks || '',
          }
        })
        setLines(mapped.length > 0 ? mapped : [defaultLine()])
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const applyCustomer = (c: Customer) => {
    customerSearch.select(c)
    setCustomerId(c.id)
    setSelectedCustomer(c)
    setFieldErrors((prev) => { const next = { ...prev }; delete next.customerId; return next })
  }

  const applyCartonToLine = useCallback((idx: number, c: CartonOption) => {
    const decorations = deriveCartonDecorations(c)
    setLines((prev) =>
      prev.map((ln, i) =>
        i === idx
          ? {
              ...ln,
              cartonId: c.id,
              cartonName: c.cartonName,
              cartonSize: c.cartonSize || '',
              artworkCode: c.artworkCode || '',
              backPrint: c.backPrint || 'No',
              rate: c.rate != null ? String(c.rate) : '',
              gsm: c.gsm != null ? String(c.gsm) : '',
              gstPct: String(c.gstPct ?? 5),
              coatingType: decorations.coatingType,
              embossingLeafing: decorations.embossingLeafing,
              paperType: c.paperType || '',
              boardGrade: c.boardGrade || '',
              foilType: decorations.foilType,
            }
          : ln
      )
    )
    setFieldErrors((prev) => { const next = { ...prev }; delete next.lines; return next })
  }, [])

  const updateLine = (idx: number, patch: Partial<Line>) => {
    setLines((prev) => prev.map((ln, i) => (i === idx ? { ...ln, ...patch } : ln)))
  }

  const addLine = () => setLines((prev) => [...prev, defaultLine()])
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx))
  const duplicateLine = (idx: number) => {
    setLines((prev) => {
      const ln = prev[idx]
      if (!ln) return prev
      const copy: Line = { ...ln, id: undefined }
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)]
    })
  }

  const validLines = lines.filter((l) => l.cartonName.trim() && l.quantity.trim() && Number(l.quantity) > 0)
  const subtotal = validLines.reduce((sum, l) => {
    const { beforeGst } = lineAmount(Number(l.rate) || 0, Number(l.quantity) || 0, Number(l.gstPct) || 0)
    return sum + beforeGst
  }, 0)
  const totalGst = validLines.reduce((sum, l) => {
    const { gst } = lineAmount(Number(l.rate) || 0, Number(l.quantity) || 0, Number(l.gstPct) || 0)
    return sum + gst
  }, 0)
  const grandTotal = subtotal + totalGst
  const totalQty = validLines.reduce((s, l) => s + (Number(l.quantity) || 0), 0)

  const supplyMaterialCounts = useMemo(() => {
    const total = lines.length
    let grey = 0
    let blue = 0
    let green = 0
    for (const l of lines) {
      const s = (l.materialProcurementStatus || 'not_calculated').toLowerCase()
      if (s === 'received') green += 1
      else if (s === 'on_order' || s === 'dispatched' || s === 'paper_ordered') blue += 1
      else grey += 1
    }
    return { total, grey, blue, green }
  }, [lines])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const err: Record<string, string> = {}
    if (!customerId) err.customerId = 'Select a customer'
    if (validLines.length === 0) err.lines = 'Add at least one line with carton name and quantity'
    setFieldErrors(err)
    if (Object.keys(err).length > 0) {
      toast.error('Please fix the errors below')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/purchase-orders/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poNumber: poNumber.trim() || undefined,
          customerId,
          poDate,
          status,
          remarks: remarks || undefined,
          deliveryRequiredBy: deliveryRequiredBy.trim() || null,
          lineItems: validLines.map((l) => ({
            id: l.id,
            dieMasterId: l.dieMasterId?.trim() || null,
            materialProcurementStatus: l.materialProcurementStatus || 'not_calculated',
            cartonId: l.cartonId || undefined,
            cartonName: l.cartonName.trim(),
            cartonSize: l.cartonSize.trim() || undefined,
            quantity: Number(l.quantity),
            artworkCode: l.artworkCode.trim() || undefined,
            backPrint: l.backPrint || 'No',
            rate: l.rate ? Number(l.rate) : undefined,
            gsm: l.gsm ? Number(l.gsm) : undefined,
            gstPct: l.gstPct ? Number(l.gstPct) : 5,
            coatingType: l.coatingType || undefined,
            embossingLeafing: l.embossingLeafing || undefined,
            paperType: l.paperType || undefined,
            remarks: l.remarks.trim() || undefined,
            specOverrides: {
              wastagePct: Number(l.wastagePct) || 10,
              boardGrade: l.boardGrade.trim() || undefined,
              foilType: l.foilType.trim() || undefined,
            },
          })),
        }),
      })
      let json: Record<string, unknown> = {}
      try { json = await res.json() } catch { /* non-JSON body */ }
      if (!res.ok) {
        if (json.fields && typeof json.fields === 'object') {
          setFieldErrors((prev) => ({ ...prev, ...(json.fields as Record<string, string>) }))
        }
        throw new Error((json.error as string) || 'Failed to save PO')
      }
      toast.success('PO updated')
      router.push('/orders/purchase-orders')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const submitQuickCreateCarton = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!customerId) { toast.error('Select a customer first'); return }
    const next: Record<string, string> = {}
    if (!qcCarton.cartonName.trim()) next.cartonName = 'Carton name is required'
    setQcCartonErrors(next)
    if (Object.keys(next).length) return
    setQcCartonSaving(true)
    try {
      const body: Record<string, unknown> = {
        cartonName: qcCarton.cartonName.trim(),
        artworkCode: qcCarton.artworkCode.trim() || undefined,
        customerId,
        rate: qcCarton.rate ? Number(qcCarton.rate) : undefined,
        gstPct: qcCarton.gstPct ? Number(qcCarton.gstPct) : 5,
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
      if (!res.ok) { toast.error(data?.error ?? 'Failed to create carton'); return }
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
        gstPct: created.gstPct ?? Number(qcCarton.gstPct || '5'),
        coatingType: (created.coatingType ?? qcCarton.coatingType) || null,
        embossingLeafing: (created.embossingLeafing ?? qcCarton.embossingLeafing) || null,
        foilType: (created.foilType ?? qcCarton.foilType) || null,
        artworkCode: created.artworkCode ?? null,
        backPrint: created.backPrint ?? 'No',
        dyeId: created.dyeId ?? null,
        specialInstructions: created.specialInstructions ?? null,
      }
      if (activeCartonLineIndex != null) applyCartonToLine(activeCartonLineIndex, formatted)
      setQcCartonOpen(false)
      setActiveCartonLineIndex(null)
      setQcCarton({ cartonName: '', artworkCode: '', sizeL: '', sizeW: '', sizeH: '', rate: '', gstPct: '5', boardGrade: '', gsm: '', paperType: '', coatingType: '', embossingLeafing: '', foilType: '' })
      setCustomerCartons((prev) => {
        if (prev.some((p) => p.id === formatted.id)) return prev
        return [...prev, formatted].sort((a, b) => a.cartonName.localeCompare(b.cartonName))
      })
      toast.success('Carton created')
    } catch {
      toast.error('Failed to create carton')
    } finally {
      setQcCartonSaving(false)
    }
  }

  const inputBase =
    'w-full px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600 text-xs placeholder:text-slate-500'
  const inputCls = `${inputBase} text-white`
  const lineCellPad = 'px-[0.35rem] py-[2px]'
  const poMono = 'po-mono-metric'

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <form onSubmit={handleSave} className="p-4 max-w-[1600px] mx-auto space-y-4 pb-32">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-slate-400 text-sm font-medium whitespace-nowrap">PO #</span>
          <input
            type="text"
            value={poNumber}
            onChange={(e) => {
              setPoNumber(e.target.value)
              setFieldErrors((prev) => { const next = { ...prev }; delete next.poNumber; return next })
            }}
            className={`px-3 py-1.5 rounded-lg bg-slate-900 border text-amber-400 font-bold text-lg font-mono ${fieldErrors.poNumber ? 'border-red-500' : 'border-slate-600'}`}
            style={{ minWidth: '14rem' }}
          />
          {fieldErrors.poNumber && <span className="text-xs text-red-400">{fieldErrors.poNumber}</span>}
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-600 text-xs text-white"
        >
          <option value="draft">Draft</option>
          <option value="confirmed">Confirmed</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {/* Header fields */}
      <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm space-y-3">
        {/* Row 1: Customer + PO date + Delivery by */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-1">
            <MasterSearchSelect
              label="Customer"
              required
              query={customerSearch.query}
              onQueryChange={(value) => {
                customerSearch.setQuery(value)
                setCustomerId('')
                setSelectedCustomer(null)
              }}
              loading={customerSearch.loading}
              options={customerSearch.options}
              lastUsed={customerSearch.lastUsed}
              onSelect={applyCustomer}
              getOptionLabel={(c) => c.name}
              getOptionMeta={(c) => [c.contactName, c.contactPhone].filter(Boolean).join(' · ')}
              error={fieldErrors.customerId}
              placeholder="Type to search customers..."
              emptyMessage="No customer found."
              recentLabel="Recent customers"
              loadingMessage="Searching customers..."
            />
            {selectedCustomer ? (
              <p className="mt-1 text-[11px] text-slate-500">
                {[selectedCustomer.contactName, selectedCustomer.contactPhone].filter(Boolean).join(' · ')}
              </p>
            ) : null}
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
        </div>
        {/* Row 2: Payment terms */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
        </div>
        {/* Row 3: Remarks + PO value */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div className="md:col-span-2">
            <label className="block text-slate-400 mb-1">Remarks</label>
            <input
              type="text"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div className="text-slate-500 text-xs pb-2 leading-snug">
            Subtotal, GST, and grand total update live in the summary dock at the bottom of the screen.
          </div>
        </div>
      </div>

      {/* Line items */}
      <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs space-y-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-slate-200 font-semibold text-sm">Line items</h2>
          <button type="button" onClick={addLine} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs">
            + Add line
          </button>
        </div>
        {fieldErrors.lines && <p className="text-red-400 text-xs">{fieldErrors.lines}</p>}
        <div className="overflow-x-auto overflow-y-auto min-h-[320px] max-h-[min(calc(100vh-15rem),720px)] rounded-md border border-slate-800/90">
          <table className="w-full text-left min-w-[1720px] border-collapse">
            <thead className="sticky top-0 z-30 backdrop-blur-md bg-slate-800/90 text-slate-300 shadow-[inset_0_-1px_0_0_rgb(51_65_85)] supports-[backdrop-filter]:bg-slate-800/75">
              <tr>
                <th className={`${lineCellPad} w-[35%] min-w-[14rem]`}>Carton name</th>
                <th className={`${lineCellPad} ${poMono} w-[9%]`}>Size</th>
                <th className={`${lineCellPad} ${poMono}`}>Qty*</th>
                <th className={`${lineCellPad}`}>Artwork</th>
                <th className={`${lineCellPad}`}>Back</th>
                <th className={`${lineCellPad}`}>Wastage%</th>
                <th className={`${lineCellPad} w-[12%]`}>Rate</th>
                <th className={lineCellPad}>GST%</th>
                <th className={`${lineCellPad} ${poMono} w-[11%]`}>Amount</th>
                <th className={lineCellPad}>Board</th>
                <th className={lineCellPad}>GSM</th>
                <th className={lineCellPad}>Paper</th>
                <th className={lineCellPad}>Coating</th>
                <th className={lineCellPad}>Emboss</th>
                <th className={lineCellPad}>Foil</th>
                <th className={lineCellPad}>Remarks</th>
                <th className={`${lineCellPad} w-8 text-center`} title="Board / paper supply vs vendor">
                  Paper
                </th>
                <th className={lineCellPad} aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {lines.map((ln, idx) => {
                const { beforeGst } = lineAmount(Number(ln.rate) || 0, Number(ln.quantity) || 0, Number(ln.gstPct) || 0)
                const paperMeta = paperSupplyIconMeta(ln.materialProcurementStatus)
                return (
                  <tr
                    key={ln.id ?? idx}
                    className={`group border-b border-slate-800/80 ${
                      idx % 2 === 0 ? 'bg-slate-900' : 'bg-slate-800/40'
                    } ${ln.cartonId ? 'border-l-2 border-l-emerald-500' : 'border-l-2 border-l-transparent'}`}
                  >
                    <td className={`${lineCellPad} align-top`}>
                      <CartonLookupField
                        line={ln}
                        customerId={customerId}
                        customerCatalog={customerCartons}
                        catalogLoading={customerCartonsLoading}
                        error={!ln.cartonName && fieldErrors.lines ? 'Carton name is required' : undefined}
                        onLineChange={(patch) => updateLine(idx, patch)}
                        onSelect={(carton) => applyCartonToLine(idx, carton)}
                        onCreate={(suggestedName) => {
                          setActiveCartonLineIndex(idx)
                          setQcCarton((prev) => ({ ...prev, cartonName: suggestedName }))
                          setQcCartonOpen(true)
                        }}
                      />
                    </td>
                    <td className={lineCellPad}>
                      <input
                        type="text"
                        value={ln.cartonSize}
                        onChange={(e) => updateLine(idx, { cartonSize: e.target.value })}
                        className={`${inputCls} ${poMono}`}
                        style={{ minWidth: '5rem', width: `${Math.max(5, (ln.cartonSize || '').length + 2) * 0.55}rem` }}
                        placeholder="L×W×H"
                      />
                    </td>
                    <td className={lineCellPad}>
                      <input type="number" min={1} value={ln.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} className={`w-[4.25rem] ${inputCls} ${poMono}`} />
                    </td>
                    <td className={lineCellPad}>
                      <input type="text" value={ln.artworkCode} onChange={(e) => updateLine(idx, { artworkCode: e.target.value })} className={`w-full min-w-0 max-w-[6.5rem] ${inputCls}`} />
                    </td>
                    <td className={lineCellPad}>
                      <select value={ln.backPrint} onChange={(e) => updateLine(idx, { backPrint: e.target.value })} className={`${inputCls} min-w-0`}>
                        <option value="No">No</option>
                        <option value="Yes">Yes</option>
                      </select>
                    </td>
                    <td className={lineCellPad}>
                      <input type="number" min={0} step={0.5} value={ln.wastagePct} onChange={(e) => updateLine(idx, { wastagePct: e.target.value })} className={`w-[4.25rem] ${inputCls}`} />
                    </td>
                    <td className={lineCellPad}>
                      <input type="number" min={0} step={0.01} value={ln.rate} onChange={(e) => updateLine(idx, { rate: e.target.value })} className={`w-full min-w-0 ${inputCls}`} />
                    </td>
                    <td className={lineCellPad}>
                      <input type="number" min={0} max={28} value={ln.gstPct} onChange={(e) => updateLine(idx, { gstPct: e.target.value })} className={`w-full min-w-0 ${inputCls}`} />
                    </td>
                    <td className={`${lineCellPad} text-white ${poMono}`}>{beforeGst.toFixed(2)}</td>
                    <td className={lineCellPad}>
                      <select value={ln.boardGrade} onChange={(e) => updateLine(idx, { boardGrade: e.target.value })} className={`${inputCls} min-w-0`}>
                        <option value="">—</option>
                        {BOARD_GRADES.map((b) => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </td>
                    <td className={lineCellPad}>
                      <input type="number" value={ln.gsm} onChange={(e) => updateLine(idx, { gsm: e.target.value })} className={`w-full min-w-0 ${inputCls} ${poMono}`} />
                    </td>
                    <td className={lineCellPad}>
                      <select value={ln.paperType} onChange={(e) => updateLine(idx, { paperType: e.target.value })} className={`${inputCls} min-w-0`}>
                        <option value="">—</option>
                        {PAPER_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td className={lineCellPad}>
                      <input type="text" value={ln.coatingType} readOnly className={`w-full min-w-0 max-w-[5.5rem] ${inputCls} text-slate-400`} placeholder="—" />
                    </td>
                    <td className={lineCellPad}>
                      <input type="text" value={ln.embossingLeafing} readOnly className={`w-full min-w-0 max-w-[5.5rem] ${inputCls} text-slate-400`} placeholder="—" />
                    </td>
                    <td className={lineCellPad}>
                      <input type="text" value={ln.foilType} readOnly className={`w-full min-w-0 max-w-[5.5rem] ${inputCls} text-slate-400`} placeholder="—" />
                    </td>
                    <td className={lineCellPad}>
                      <input type="text" value={ln.remarks} onChange={(e) => updateLine(idx, { remarks: e.target.value })} className={`w-full min-w-0 max-w-[7rem] ${inputCls}`} />
                    </td>
                    <td className={`${lineCellPad} align-middle text-center`}>
                      <span title={paperMeta.title} className="inline-flex justify-center">
                        <FileText className={`h-3.5 w-3.5 ${paperMeta.iconClassName}`} strokeWidth={2} aria-hidden />
                      </span>
                    </td>
                    <td className={`${lineCellPad} align-middle`}>
                      <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <button
                          type="button"
                          title="Duplicate line"
                          onClick={() => duplicateLine(idx)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-700/80 hover:text-amber-300"
                        >
                          <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                        </button>
                        {lines.length > 1 ? (
                          <button
                            type="button"
                            title="Remove line"
                            onClick={() => removeLine(idx)}
                            className="rounded p-1 text-red-400/80 hover:bg-red-950/50 hover:text-red-300"
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={() => router.push('/orders/purchase-orders')} className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="ci-btn-save-industrial px-5 py-2 text-sm">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <div
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-700/50 bg-slate-950/82 backdrop-blur-md supports-[backdrop-filter]:bg-slate-950/68 shadow-[0_-6px_28px_rgba(0,0,0,0.45)]"
        aria-live="polite"
        aria-label="Purchase order financial summary"
      >
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[11px] sm:text-xs">
          <span className="font-semibold uppercase tracking-wider text-slate-500">Live summary</span>
          <div className="flex min-w-[12rem] max-w-md flex-1 flex-col gap-1.5 px-2">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-600">
              Supply progress — Material
            </div>
            <div className="flex h-1.5 w-full flex-row overflow-hidden rounded-full bg-slate-800/95 ring-1 ring-slate-700/80">
              {supplyMaterialCounts.total > 0 ? (
                <>
                  <div
                    className="h-full flex-none bg-slate-600 transition-[width] duration-300 ease-out"
                    style={{
                      width: `${(supplyMaterialCounts.grey / supplyMaterialCounts.total) * 100}%`,
                    }}
                    title={`Not calculated / pre-dispatch: ${supplyMaterialCounts.grey} / ${supplyMaterialCounts.total}`}
                  />
                  <div
                    className="h-full flex-none bg-sky-500 transition-[width] duration-300 ease-out"
                    style={{
                      width: `${(supplyMaterialCounts.blue / supplyMaterialCounts.total) * 100}%`,
                    }}
                    title={`On order (vendor PO sent): ${supplyMaterialCounts.blue} / ${supplyMaterialCounts.total}`}
                  />
                  <div
                    className="h-full flex-none bg-emerald-500 transition-[width] duration-300 ease-out"
                    style={{
                      width: `${(supplyMaterialCounts.green / supplyMaterialCounts.total) * 100}%`,
                    }}
                    title={`Received at factory: ${supplyMaterialCounts.green} / ${supplyMaterialCounts.total}`}
                  />
                </>
              ) : null}
            </div>
            <div className="text-[10px] text-slate-500 text-right tabular-nums">
              <span className="text-slate-500">{supplyMaterialCounts.grey}</span> grey ·{' '}
              <span className="text-sky-400">{supplyMaterialCounts.blue}</span> blue ·{' '}
              <span className="text-emerald-400">{supplyMaterialCounts.green}</span> green
              <span className="text-slate-600"> / {supplyMaterialCounts.total} lines</span>
            </div>
          </div>
          <div className="flex flex-wrap items-baseline justify-end gap-x-6 gap-y-1 text-slate-400">
            <span>
              Total qty <span className={`${poMono} text-white`}>{totalQty}</span>
            </span>
            <span>
              Subtotal{' '}
              <span className={`${poMono} text-white`}>
                ₹ {subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            </span>
            <span>
              GST{' '}
              <span className={`${poMono} text-white`}>
                ₹ {totalGst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            </span>
            <span className="text-slate-300">
              Grand total{' '}
              <span className={`${poMono} text-base font-semibold text-amber-200`}>
                ₹ {grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* Quick Create Carton panel */}
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
          <div>
            <label className="block text-xs text-slate-400 mb-1">Artwork Code (AW)</label>
            <input
              type="text"
              value={qcCarton.artworkCode}
              onChange={(e) => setQcCarton((prev) => ({ ...prev, artworkCode: e.target.value.toUpperCase() }))}
              className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white font-mono"
              placeholder="e.g. AW-12345"
            />
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
              {EMBOSSING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={qcCarton.foilType} onChange={(e) => setQcCarton((prev) => ({ ...prev, foilType: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white">
              <option value="">—</option>
              {FOIL_TYPES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={qcCartonSaving} className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium">
              {qcCartonSaving ? 'Saving…' : 'Save Carton'}
            </button>
          </div>
        </form>
      </SlideOverPanel>
    </form>
  )
}
