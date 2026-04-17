'use client'

import { useEffect, useMemo, useState } from 'react'
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
import {
  mapApiRowToPoCarton,
  usePoRecentCartons,
  type PoCartonCatalogItem,
} from '@/lib/po-carton-autocomplete'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { parseCartonSizeToDims } from '@/lib/die-hub-dimensions'

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
  dieMasterId: string
  toolingDieType: string
  toolingDims: string
  toolingUnlinked: boolean
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
  dieMasterId: '',
  toolingDieType: '',
  toolingDims: '',
  toolingUnlinked: false,
})

function hasLineInput(line: Line): boolean {
  return Object.entries(line).some(([key, value]) => {
    if (key === 'backPrint') return value !== 'No'
    if (key === 'wastagePct') return value !== '10'
    if (key === 'gstPct') return value !== '5'
    return String(value).trim() !== ''
  })
}

function resetAutofillFields(line: Line, cartonName: string): Line {
  if (!line.cartonId) return { ...line, cartonName }
  return {
    ...line,
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
    dieMasterId: '',
    toolingDieType: '',
    toolingDims: '',
    toolingUnlinked: false,
  }
}

function lineAmount(rate: number, chargeableQty: number, gstPct: number): { beforeGst: number; gst: number } {
  const beforeGst = rate * chargeableQty
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
        notes?: string
        brailleEnabled?: boolean
        leafingEnabled?: boolean
        embossingEnabled?: boolean
        spotUvEnabled?: boolean
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

export default function NewPurchaseOrderPage() {
  const router = useRouter()
  const [customerId, setCustomerId] = useState('')
  const [poDate, setPoDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [customPoNumber, setCustomPoNumber] = useState('')
  const [deliveryRequiredBy, setDeliveryRequiredBy] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [remarks, setRemarks] = useState('')
  const [lines, setLines] = useState<Line[]>([defaultLine()])
  const [saving, setSaving] = useState(false)
  const [activeCartonLineIndex, setActiveCartonLineIndex] = useState<number | null>(null)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)

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

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
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

  const loadCustomerDefaults = async (nextCustomerId: string) => {
    try {
      const res = await fetch(`/api/customers/${nextCustomerId}/po-defaults`)
      if (!res.ok) {
        setPaymentTerms('')
        return
      }
      const data = (await res.json()) as { paymentTerms?: string | null }
      setPaymentTerms(data.paymentTerms?.trim() || '')
    } catch {
      setPaymentTerms('')
    }
  }

  const applyCustomer = (c: Customer) => {
    customerSearch.select(c)
    const switchingCustomer = customerId && customerId !== c.id
    setCustomerId(c.id)
    setSelectedCustomer(c)
    void loadCustomerDefaults(c.id)
    setFieldErrors((prev) => {
      const next = { ...prev }
      delete next.customerId
      return next
    })
    if (switchingCustomer && lines.some(hasLineInput)) {
      setLines([defaultLine()])
      toast.info('Line items were reset for the newly selected customer.')
    }
  }

  const applyCartonToLine = (idx: number, c: CartonOption) => {
    const decorations = deriveCartonDecorations(c)
    const raw = (c.toolingDimsLabel || c.cartonSize || '').trim()
    const sizeForLine = raw.replace(/x/gi, '×')
    updateLine(idx, {
      cartonId: c.id,
      cartonName: c.cartonName,
      cartonSize: sizeForLine,
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
      dieMasterId: c.dieMasterId || c.dyeId || '',
      toolingDieType: c.masterDieType || '',
      toolingDims: sizeForLine,
      toolingUnlinked: !!c.toolingUnlinked,
    })
    setFieldErrors((prev) => {
      const next = { ...prev }
      delete next.lines
      return next
    })
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
    const rate = Number(l.rate) || 0
    const gstPct = Number(l.gstPct) || 0
    const { beforeGst } = lineAmount(rate, qty, gstPct)
    return sum + beforeGst
  }, 0)
  const totalGst = validLines.reduce((sum, l) => {
    const qty = Number(l.quantity) || 0
    const rate = Number(l.rate) || 0
    const gstPct = Number(l.gstPct) || 0
    const { gst } = lineAmount(rate, qty, gstPct)
    return sum + gst
  }, 0)
  const grandTotal = subtotal + totalGst
  const totalQty = validLines.reduce((s, l) => s + (Number(l.quantity) || 0), 0)

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
          ...(customPoNumber.trim() ? { poNumber: customPoNumber.trim() } : {}),
          remarks: combinedRemarks || undefined,
          lineItems: validLines.map((l) => {
            const qty = Number(l.quantity)
            const wastage = Number(l.wastagePct) || 0
            const dimSrc = l.toolingDims.trim() || l.cartonSize.trim()
            const td = parseCartonSizeToDims(dimSrc)
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
              dieMasterId: l.dieMasterId.trim() || undefined,
              toolingLocked: true,
              lineDieType: l.toolingDieType.trim() || undefined,
              dimLengthMm: td?.l,
              dimWidthMm: td?.w,
              dimHeightMm: td?.h,
              specOverrides: {
                wastagePct: wastage,
                boardGrade: l.boardGrade.trim() || undefined,
                foilType: l.foilType.trim() || undefined,
                masterDieType: l.toolingDieType.trim() || undefined,
                dieMasterId: l.dieMasterId.trim() || undefined,
              },
            }
          }),
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
        gstPct: created.gstPct ?? Number(qcCarton.gstPct || '5'),
        coatingType: (created.coatingType ?? qcCarton.coatingType) || null,
        embossingLeafing: (created.embossingLeafing ?? qcCarton.embossingLeafing) || null,
        foilType: (created.foilType ?? qcCarton.foilType) || null,
        artworkCode: created.artworkCode ?? null,
        backPrint: created.backPrint ?? 'No',
        dyeId: created.dyeId ?? null,
        dieMasterId: (created as { dieMasterId?: string | null }).dieMasterId ?? null,
        masterDieType: null,
        toolingDimsLabel: cartonSizeStr || null,
        toolingUnlinked: !(created as { dieMasterId?: string | null }).dieMasterId,
        specialInstructions: created.specialInstructions ?? null,
      }
      if (activeCartonLineIndex != null) {
        applyCartonToLine(activeCartonLineIndex, formatted)
      }
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

  const inputCls = 'w-full px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-xs'
  const inputErr = 'border-red-500'

  return (
    <form onSubmit={handleSubmit} className="p-4 max-w-[1600px] mx-auto space-y-4">
      <h1 className="text-xl font-bold text-amber-400">New Purchase Order</h1>

      <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm space-y-3">
        {/* Row 1: Customer (wide) + PO date + Delivery by */}
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
              getOptionMeta={(c) =>
                [c.contactName, c.contactPhone].filter(Boolean).join(' · ')
              }
              error={fieldErrors.customerId}
              placeholder="Type to search customers..."
              emptyMessage="No customer found in master."
              recentLabel="Recent customers"
              loadingMessage="Searching customers..."
              emptyActionLabel={
                customerSearch.query.trim()
                  ? `Create "${customerSearch.query.trim()}" as new customer`
                  : undefined
              }
              onEmptyAction={() => {
                const suggestedName = customerSearch.query.trim()
                setQcCustomer((prev) => ({
                  ...prev,
                  name: suggestedName || prev.name,
                }))
                setQcCustomerOpen(true)
              }}
            />
            <button type="button" onClick={() => setQcCustomerOpen(true)} className="mt-1 text-xs text-amber-400 hover:underline">
              Create New Customer
            </button>
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
        {/* Row 2: Custom PO# + Payment terms */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-slate-400 mb-1">Custom PO number <span className="text-slate-500">(optional)</span></label>
            <input
              type="text"
              value={customPoNumber}
              onChange={(e) => {
                setCustomPoNumber(e.target.value)
                setFieldErrors((prev) => {
                  const next = { ...prev }
                  delete next.poNumber
                  return next
                })
              }}
              className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white ${fieldErrors.poNumber ? 'border-red-500' : 'border-slate-600'}`}
              placeholder="Leave blank to auto-generate"
            />
            {fieldErrors.poNumber ? (
              <p className="mt-1 text-xs text-red-400">{fieldErrors.poNumber}</p>
            ) : null}
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
          <div className="text-slate-400 text-sm pb-2">
            PO value: <span className="text-white font-medium">₹ {grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          </div>
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
          <table className="w-full text-left min-w-[1900px]">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="px-2 py-1">Carton name</th>
                <th className="px-2 py-1">Size</th>
                <th className="px-2 py-1">Die Type</th>
                <th className="px-2 py-1">Qty*</th>
                <th className="px-2 py-1">Artwork</th>
                <th className="px-2 py-1">Back</th>
                <th className="px-2 py-1">Wastage%</th>
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
                const rate = Number(ln.rate) || 0
                const gstPct = Number(ln.gstPct) || 0
                const { beforeGst } = lineAmount(rate, qty, gstPct)
                const amount = beforeGst
                const dieTypeMissing = !!ln.cartonId && !ln.toolingDieType.trim()
                return (
                  <tr key={idx} className="border-t border-slate-800">
                    <td className="px-2 py-1 align-top">
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
                      {ln.cartonId && ln.toolingUnlinked ? (
                        <p className="text-[10px] text-amber-400 font-semibold mt-1">Unlinked tooling</p>
                      ) : null}
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={ln.cartonSize}
                        onChange={(e) => {
                          const v = e.target.value
                          updateLine(idx, { cartonSize: v, toolingDims: v })
                        }}
                        className={inputCls}
                        style={{ minWidth: '6rem', width: `${Math.max(6, (ln.cartonSize || '').length + 3) * 0.6}rem` }}
                        placeholder="L×W×H"
                      />
                    </td>
                    <td className="px-2 py-1 align-top min-w-[7rem] max-w-[11rem]">
                      <div
                        className={`rounded px-2 py-1 text-xs min-h-[1.75rem] flex flex-col justify-center ${
                          dieTypeMissing
                            ? 'bg-red-950/50 border border-red-600/70 text-red-100'
                            : 'bg-slate-900/90 border border-slate-600/80 text-slate-200'
                        }`}
                      >
                        {ln.toolingDieType.trim() ? (
                          <span className="font-medium leading-snug">{ln.toolingDieType.trim()}</span>
                        ) : ln.cartonId ? (
                          <span className="text-slate-500">—</span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </div>
                      {dieTypeMissing ? (
                        <p className="text-[10px] text-red-400 mt-0.5 leading-tight">Define Die Type in Master.</p>
                      ) : null}
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        min={1}
                        value={ln.quantity}
                        onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                        className={`w-20 ${inputCls} ${fieldErrors[`line${idx}_rate`] ? inputErr : ''}`}
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input type="text" value={ln.artworkCode} onChange={(e) => updateLine(idx, { artworkCode: e.target.value })} className={`w-28 ${inputCls}`} />
                    </td>
                    <td className="px-2 py-1">
                      <select value={ln.backPrint} onChange={(e) => updateLine(idx, { backPrint: e.target.value })} className={inputCls}>
                        <option value="No">No</option>
                        <option value="Yes">Yes</option>
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" min={0} step={0.5} value={ln.wastagePct} onChange={(e) => updateLine(idx, { wastagePct: e.target.value })} className={`w-20 ${inputCls}`} />
                    </td>
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
                      <input type="number" min={0} max={28} value={ln.gstPct} onChange={(e) => updateLine(idx, { gstPct: e.target.value })} className={`w-16 ${inputCls}`} />
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
                      <input type="text" value={ln.coatingType} readOnly className={`w-32 ${inputCls} text-slate-300`} placeholder="—" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="text" value={ln.embossingLeafing} readOnly className={`w-32 ${inputCls} text-slate-300`} placeholder="—" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="text" value={ln.foilType} readOnly className={`w-32 ${inputCls} text-slate-300`} placeholder="—" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="text" value={ln.remarks} onChange={(e) => updateLine(idx, { remarks: e.target.value })} className={`w-40 ${inputCls}`} />
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
                <td colSpan={3} className="px-2 py-2">Total</td>
                <td className="px-2 py-2 tabular-nums">{totalQty}</td>
                <td colSpan={5} />
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
