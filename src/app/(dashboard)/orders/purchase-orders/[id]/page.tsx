'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  BOARD_GRADES,
  PAPER_TYPES,
  COATING_TYPES,
  EMBOSSING_TYPES,
  FOIL_TYPES,
} from '@/lib/constants'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import {
  mapApiRowToPoCarton,
  usePoRecentCartons,
  type PoCartonCatalogItem,
} from '@/lib/po-carton-autocomplete'
import {
  Copy,
  FileText,
  FlipHorizontal2,
  Layers,
  Sparkles,
  Star,
  Sun,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { paperSupplyIconMeta } from '@/lib/po-paper-supply-ui'
import { parseDeliveryYmdFromRemarks } from '@/lib/po-delivery-parse'
import { broadcastIndustrialPriorityChange } from '@/lib/industrial-priority-sync'
import { ProductionReadinessBar } from '@/components/orders/ProductionReadinessBar'
import type { ProductionKitForLine } from '@/lib/production-kit-status'

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
  directorPriority?: boolean
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
  directorPriority: false,
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
      if (!coatingType && parsed.spotUvEnabled) coatingType = 'Full UV Coating'
      if (!embossingLeafing) {
        if (parsed.embossingEnabled && parsed.leafingEnabled) embossingLeafing = 'Gold Foil Stamping'
        else if (parsed.embossingEnabled) embossingLeafing = 'Blind Embossing'
        else if (parsed.leafingEnabled) embossingLeafing = 'Gold Foil Stamping'
      }
      if (!foilType && parsed.leafingEnabled) foilType = 'Gold Foil Stamping'
    } catch {}
  }

  return { coatingType, embossingLeafing, foilType }
}

function IconSpecSelect({
  icon: Icon,
  label,
  value,
  options,
  onChange,
  mono,
}: {
  icon: LucideIcon
  label: string
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  mono?: boolean
}) {
  return (
    <div className="relative flex min-w-[6.5rem] max-w-[9rem] flex-col items-stretch gap-0.5" title={label}>
      <Icon
        className="h-3 w-3 shrink-0 self-center text-ds-ink-faint opacity-70 transition-colors group-hover:text-[#f97316]"
        strokeWidth={2}
        aria-hidden
      />
      <PackagingEnumCombobox
        aria-label={label}
        options={options}
        value={value || null}
        onChange={(v) => onChange(v ?? '')}
        controlClassName="border-ds-line/50 bg-ds-card/90 hover:bg-ds-card focus-within:ring-blue-500/30"
        inputClassName={`text-[9px] leading-tight text-ds-ink placeholder:text-ds-ink-faint ${mono ? 'po-mono-metric' : ''}`}
        className="w-full"
      />
    </div>
  )
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
    <div className="min-w-[200px] w-full max-w-full">
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
        inputClassName="min-w-0 w-full max-w-full px-1.5 py-0.5 text-[11px]"
        dropdownClassName="min-w-[280px]"
      />
      {!line.cartonId && line.cartonName.trim() ? (
        <span className="mt-1 inline-block text-[10px] text-ds-warning">Unsaved carton name</span>
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
  const [focusedRowIndex, setFocusedRowIndex] = useState<number | null>(null)

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
  const [productionKit, setProductionKit] = useState<{
    lines: ProductionKitForLine[]
    allOk: boolean
    anyRose: boolean
  } | null>(null)
  const [productionKitLoading, setProductionKitLoading] = useState(true)
  const [releasingToPlanning, setReleasingToPlanning] = useState(false)
  const [toolingGapAck, setToolingGapAck] = useState(false)

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
            directorPriority: li.directorPriority === true,
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

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setProductionKitLoading(true)
    void (async () => {
      try {
        const res = await fetch(`/api/purchase-orders/${id}/production-kit`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j || typeof j !== 'object') {
          setProductionKit(null)
          return
        }
        setProductionKit({
          lines: Array.isArray(j.lines) ? j.lines : [],
          allOk: j.allOk === true,
          anyRose: j.anyRose === true,
        })
      } catch {
        if (!cancelled) setProductionKit(null)
      } finally {
        if (!cancelled) setProductionKitLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
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
      const copy = structuredClone(ln) as Line
      copy.id = undefined
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)]
    })
  }

  const validLines = lines.filter((l) => l.cartonName.trim() && l.quantity.trim() && Number(l.quantity) > 0)
  const allLinesProductLinked = validLines.length > 0 && validLines.every((l) => String(l.cartonId ?? '').trim())
  const poSentToPlanning = status === 'sent_to_planning'
  const releaseStatusOk = status === 'confirmed' || status === 'approved'
  const canReleaseToPlanning = useMemo(() => {
    if (poSentToPlanning || !releaseStatusOk) return false
    if (!customerId || !poDate.trim() || !deliveryRequiredBy.trim()) return false
    if (validLines.length === 0 || !allLinesProductLinked) return false
    if (productionKitLoading || !productionKit) return false
    if (!productionKit.allOk && !toolingGapAck) return false
    return true
  }, [
    poSentToPlanning,
    releaseStatusOk,
    customerId,
    poDate,
    deliveryRequiredBy,
    validLines.length,
    allLinesProductLinked,
    productionKitLoading,
    productionKit,
    toolingGapAck,
  ])
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
    if (poSentToPlanning) {
      setSaving(true)
      try {
        const res = await fetch(`/api/purchase-orders/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            remarks: remarks || undefined,
            deliveryRequiredBy: deliveryRequiredBy.trim() || null,
          }),
        })
        const json: Record<string, unknown> = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((json.error as string) || 'Failed to save')
        toast.success('Notes saved')
        broadcastIndustrialPriorityChange({
          source: 'line_director_priority',
          at: new Date().toISOString(),
        })
        router.push('/orders/purchase-orders')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save')
      } finally {
        setSaving(false)
      }
      return
    }
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
            directorPriority: l.directorPriority === true,
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
      broadcastIndustrialPriorityChange({
        source: 'line_director_priority',
        at: new Date().toISOString(),
      })
      router.push('/orders/purchase-orders')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function releaseToPlanning() {
    if (!canReleaseToPlanning || releasingToPlanning) return
    setReleasingToPlanning(true)
    try {
      const res = await fetch(`/api/purchase-orders/${id}/release-to-planning`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acknowledgeToolingGaps: toolingGapAck,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        code?: string
        productionKit?: { allOk: boolean }
      }
      if (res.status === 409 && json.code === 'TOOLING' && !toolingGapAck) {
        toast.error(json.error || 'Review tooling, or confirm override below')
        return
      }
      if (!res.ok) {
        throw new Error(json.error || 'Release failed')
      }
      setStatus('sent_to_planning')
      setToolingGapAck(false)
      toast.success('Moved to Planning')
      void fetch(`/api/purchase-orders/${id}/production-kit`)
        .then((r) => r.json())
        .then((d) => {
          if (d && !d.error) setProductionKit(d)
        })
        .catch(() => {})
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Release failed')
    } finally {
      setReleasingToPlanning(false)
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
    'w-full px-1.5 py-0.5 rounded-md bg-[#111827]/90 border border-ds-line/40 text-[11px] text-ds-ink placeholder:text-ds-ink-faint focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/45'
  const inputCls = inputBase
  const lineCellPad = 'px-1 py-0.5'
  const poMono = 'po-mono-metric'
  const rowStripe = (i: number) => (i % 2 === 0 ? 'bg-[#161B26]' : 'bg-[#111827]')

  if (loading) {
    return (
      <div className="min-h-[40vh] bg-[#0B0F1A] p-4 text-ds-ink-muted">Loading…</div>
    )
  }

  return (
    <form
      onSubmit={handleSave}
      className="min-h-screen bg-[#0B0F1A] px-3 py-3 sm:px-4 space-y-3 pb-36 max-w-[1920px] mx-auto w-full"
    >
      {/* Director's glass — metadata */}
      <div className="rounded-xl border border-border/40 bg-card/30 px-3 py-3 backdrop-blur-md sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/40 pb-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted">PO #</div>
            <input
              type="text"
              value={poNumber}
              readOnly={poSentToPlanning}
              onChange={(e) => {
                setPoNumber(e.target.value)
                setFieldErrors((prev) => {
                  const next = { ...prev }
                  delete next.poNumber
                  return next
                })
              }}
              className={`mt-0.5 w-full min-w-[10rem] max-w-[16rem] border-b-2 border-transparent bg-transparent font-mono text-lg font-bold text-ds-warning focus:border-blue-500 focus:outline-none ${fieldErrors.poNumber ? 'ring-1 ring-red-500/60' : ''} ${poSentToPlanning ? 'cursor-not-allowed opacity-80' : ''}`}
            />
            {fieldErrors.poNumber ? (
              <span className="mt-0.5 block text-xs text-red-400">{fieldErrors.poNumber}</span>
            ) : null}
          </div>
          <div className="flex shrink-0 max-w-md flex-col items-stretch gap-2 sm:items-end">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted sm:text-right">Status</div>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={poSentToPlanning}
                className="mt-1 w-full min-w-[10rem] rounded-lg border border-ds-line/40 bg-[#111827]/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40 sm:text-right enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-80"
              >
                <option value="draft">Draft</option>
                <option value="confirmed">Confirmed</option>
                <option value="approved">Approved</option>
                <option value="closed">Closed</option>
                {poSentToPlanning && <option value="sent_to_planning">Sent to Planning</option>}
              </select>
            </div>
            {!poSentToPlanning ? (
              <div className="flex w-full min-w-0 flex-col items-stretch gap-1.5 sm:max-w-xs sm:items-end">
                {!releaseStatusOk ? (
                  <p className="text-right text-[10px] text-ds-warning/90 sm:max-w-[16rem]">
                    Set status to Confirmed or Approved to release to Planning.
                  </p>
                ) : null}
                {releaseStatusOk && !productionKitLoading && productionKit && !productionKit.allOk ? (
                  <label className="flex cursor-pointer items-center justify-end gap-2 text-[10px] text-ds-warning">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-ds-line/50"
                      checked={toolingGapAck}
                      onChange={(e) => setToolingGapAck(e.target.checked)}
                    />
                    Acknowledge tooling / shade gaps — release anyway
                  </label>
                ) : null}
                {releaseStatusOk && validLines.length > 0 && !allLinesProductLinked ? (
                  <p className="text-right text-[10px] text-ds-warning/90">Link every line to a master product to release.</p>
                ) : null}
                {releaseStatusOk && (!deliveryRequiredBy.trim() || !poDate.trim()) ? (
                  <p className="text-right text-[10px] text-ds-warning/90">PO date and delivery date are required.</p>
                ) : null}
                <button
                  type="button"
                  onClick={releaseToPlanning}
                  disabled={!canReleaseToPlanning || releasingToPlanning}
                  className="w-full rounded-lg bg-ds-warning px-3 py-2 text-xs font-bold text-white shadow transition-colors hover:bg-ds-warning disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                >
                  {releasingToPlanning ? 'Releasing…' : 'Release to Planning'}
                </button>
              </div>
            ) : (
              <p className="text-right text-[10px] leading-snug text-emerald-400/90">
                In Planning — lines are read-only.{' '}
                <Link href="/orders/planning" className="font-semibold text-ds-warning underline underline-offset-2">
                  Open queue
                </Link>
                .
              </p>
            )}
          </div>
        </div>

        <fieldset disabled={poSentToPlanning} className="min-w-0 space-y-3 border-0 p-0">
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted">Customer</div>
            <div className="mt-1">
              <MasterSearchSelect
                label="Customer"
                required
                hideLabel
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
                placeholder="Search customer…"
                emptyMessage="No customer found."
                recentLabel="Recent customers"
                loadingMessage="Searching customers..."
                inputClassName="min-w-0 w-full border border-ds-line/40 bg-[#111827]/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40"
              />
            </div>
            {selectedCustomer ? (
              <p className="mt-1 text-[10px] text-ds-ink-faint">
                {[selectedCustomer.contactName, selectedCustomer.contactPhone].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted">PO date</div>
            <input
              type="date"
              value={poDate}
              onChange={(e) => setPoDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ds-line/40 bg-[#111827]/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
            />
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted">Delivery</div>
            <input
              type="date"
              value={deliveryRequiredBy}
              onChange={(e) => setDeliveryRequiredBy(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ds-line/40 bg-[#111827]/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
            />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted">Payment terms</div>
            <input
              type="text"
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ds-line/40 bg-[#111827]/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
              placeholder="e.g. 30 days"
            />
          </div>
        </div>
        </fieldset>
        <div className="mt-3">
            <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted">Remarks (editable after release)</div>
            <input
              type="text"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ds-line/40 bg-[#111827]/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
            />
        </div>
      </div>

      <ProductionReadinessBar
        lines={productionKit?.lines ?? []}
        allOk={productionKit?.allOk ?? false}
        anyRose={productionKit?.anyRose ?? false}
        loading={productionKitLoading}
      />

      {/* Zero-scroll line grid */}
      <fieldset disabled={poSentToPlanning} className="min-w-0 border-0 p-0">
      <div className="rounded-xl border border-border/40 bg-card/20 p-2 text-[11px] backdrop-blur-sm sm:p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ds-ink-muted">Line items</h2>
          <button
            type="button"
            onClick={addLine}
            className="rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground/80 hover:border-blue-500/40 hover:text-foreground"
          >
            + Add line
          </button>
        </div>
        {fieldErrors.lines ? <p className="mb-2 text-xs text-red-400">{fieldErrors.lines}</p> : null}
        <div className="max-h-[min(calc(100vh-14rem),760px)] overflow-x-hidden overflow-y-auto rounded-lg border border-ds-line/50">
          <table className="w-full table-fixed border-collapse text-left">
            <thead className="sticky top-0 z-20 border-b border-ds-line/40 bg-[#111827]/95 text-[10px] font-semibold uppercase tracking-wide text-ds-ink-faint backdrop-blur-md">
              <tr>
                <th className={`${lineCellPad} w-10 text-center`} title="Priority & row tools" aria-label="Row tools">
                  {/* 40px tool column */}
                </th>
                <th className={`${lineCellPad} min-w-[200px] w-[22%]`}>Carton</th>
                <th className={`${lineCellPad} w-[100px] ${poMono}`}>Size</th>
                <th className={`${lineCellPad} w-20 ${poMono}`}>Qty</th>
                <th className={lineCellPad}>AW</th>
                <th className={`${lineCellPad} w-11`}>W%</th>
                <th className={lineCellPad}>Brd</th>
                <th className={`${lineCellPad} w-12`}>GSM</th>
                <th className={`${lineCellPad} w-[4.5rem]`}>Paper</th>
                <th className={`${lineCellPad} w-[168px]`}>₹ Fin</th>
                <th className={`${lineCellPad} w-12 text-center`} title="Back print">
                  <FlipHorizontal2 className="mx-auto h-3 w-3 opacity-60" aria-hidden />
                </th>
                <th className={`${lineCellPad} w-12 text-center`} title="Coating">
                  <Layers className="mx-auto h-3 w-3 opacity-60" aria-hidden />
                </th>
                <th className={`${lineCellPad} w-12 text-center`} title="Emboss / leaf">
                  <Sparkles className="mx-auto h-3 w-3 opacity-60" aria-hidden />
                </th>
                <th className={`${lineCellPad} w-12 text-center`} title="Foil">
                  <Sun className="mx-auto h-3 w-3 opacity-60" aria-hidden />
                </th>
                <th className={`${lineCellPad} min-w-0`}>Rm</th>
                <th className={`${lineCellPad} w-7 text-center`} title="Material supply">
                  M
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((ln, idx) => {
                const { beforeGst } = lineAmount(
                  Number(ln.rate) || 0,
                  Number(ln.quantity) || 0,
                  Number(ln.gstPct) || 0,
                )
                const paperMeta = paperSupplyIconMeta(ln.materialProcurementStatus)
                const focused = focusedRowIndex === idx
                return (
                  <tr
                    key={ln.id ?? idx}
                    onFocusCapture={() => setFocusedRowIndex(idx)}
                    className={`group border-b border-ds-line/40 ${rowStripe(idx)} ${
                      focused ? 'border-l-2 border-l-[#f59e0b]' : 'border-l-2 border-l-transparent'
                    }`}
                  >
                    <td className={`${lineCellPad} w-10 align-middle`}>
                      <div className="flex w-10 flex-col items-center gap-0.5 opacity-20 transition-[opacity,color] duration-150 group-hover:opacity-100 group-hover:text-[#f97316]">
                        <button
                          type="button"
                          title={ln.directorPriority ? 'Clear director priority' : 'Director priority'}
                          onClick={() => updateLine(idx, { directorPriority: !ln.directorPriority })}
                          className={`rounded p-0.5 transition-colors ${
                            ln.directorPriority
                              ? 'text-[#f59e0b] group-hover:text-[#f97316]'
                              : 'text-ds-ink-faint group-hover:text-[#f97316]'
                          }`}
                        >
                          <Star
                            className={`h-3.5 w-3.5 ${ln.directorPriority ? 'fill-[#f59e0b]' : ''}`}
                            strokeWidth={2}
                          />
                        </button>
                        <button
                          type="button"
                          title="Duplicate line"
                          onClick={() => duplicateLine(idx)}
                          className="rounded p-0.5 text-ds-ink-faint transition-colors group-hover:text-[#f97316]"
                        >
                          <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                        </button>
                        <button
                          type="button"
                          title={lines.length > 1 ? 'Remove line' : 'At least one line required'}
                          disabled={lines.length <= 1}
                          onClick={() => lines.length > 1 && removeLine(idx)}
                          className="rounded p-0.5 text-ds-ink-faint transition-colors group-hover:text-[#f97316] disabled:cursor-not-allowed disabled:opacity-25 disabled:group-hover:text-ds-ink-faint"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                        </button>
                      </div>
                    </td>
                    <td className={`${lineCellPad} min-w-[200px] align-top`}>
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
                        className={`${inputCls} ${poMono} w-full max-w-[100px]`}
                        placeholder="L×W×H"
                      />
                    </td>
                    <td className={lineCellPad}>
                      <input
                        type="number"
                        min={1}
                        value={ln.quantity}
                        onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                        className={`w-full max-w-[80px] ${inputCls} ${poMono}`}
                      />
                    </td>
                    <td className={lineCellPad}>
                      <input
                        type="text"
                        value={ln.artworkCode}
                        onChange={(e) => updateLine(idx, { artworkCode: e.target.value })}
                        className={`w-full min-w-0 ${inputCls} font-mono text-[10px]`}
                      />
                    </td>
                    <td className={lineCellPad}>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={ln.wastagePct}
                        onChange={(e) => updateLine(idx, { wastagePct: e.target.value })}
                        className={`w-full max-w-[2.75rem] ${inputCls} ${poMono}`}
                      />
                    </td>
                    <td className={lineCellPad}>
                      <PackagingEnumCombobox
                        aria-label="Board grade"
                        options={BOARD_GRADES}
                        value={ln.boardGrade || null}
                        onChange={(v) => updateLine(idx, { boardGrade: v ?? '' })}
                        controlClassName="border-ds-line/50 bg-ds-card/80"
                        inputClassName="text-[10px] text-ds-ink"
                        className="min-w-[6rem] max-w-[10rem]"
                      />
                    </td>
                    <td className={lineCellPad}>
                      <input
                        type="number"
                        value={ln.gsm}
                        onChange={(e) => updateLine(idx, { gsm: e.target.value })}
                        className={`w-full min-w-0 ${inputCls} ${poMono} text-[10px]`}
                      />
                    </td>
                    <td className={lineCellPad}>
                      <PackagingEnumCombobox
                        aria-label="Paper / board type"
                        options={PAPER_TYPES}
                        value={ln.paperType || null}
                        onChange={(v) => updateLine(idx, { paperType: v ?? '' })}
                        controlClassName="border-ds-line/50 bg-ds-card/80"
                        inputClassName="text-[9px] text-ds-ink"
                        className="min-w-[6rem] max-w-[10rem]"
                      />
                    </td>
                    <td className={lineCellPad}>
                      <div className="rounded-md bg-ds-elevated/95 px-1.5 py-1 ring-1 ring-ds-line/50">
                        <div className="flex items-center justify-between gap-1 text-[9px] text-ds-ink-faint">
                          <span>Rate</span>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={ln.rate}
                            onChange={(e) => updateLine(idx, { rate: e.target.value })}
                            className={`w-16 border-0 bg-transparent p-0 text-right ${poMono} text-[10px] font-semibold text-ds-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/60`}
                          />
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-1 text-[9px] text-ds-ink-faint">
                          <span>GST%</span>
                          <input
                            type="number"
                            min={0}
                            max={28}
                            value={ln.gstPct}
                            onChange={(e) => updateLine(idx, { gstPct: e.target.value })}
                            className={`w-10 border-0 bg-transparent p-0 text-right ${poMono} text-[10px] text-ds-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/60`}
                          />
                        </div>
                        <div
                          className={`mt-0.5 border-t border-ds-line/50 pt-0.5 text-right text-[10px] font-semibold text-foreground ${poMono}`}
                        >
                          {beforeGst.toFixed(2)}
                        </div>
                      </div>
                    </td>
                    <td className={`${lineCellPad} align-middle`}>
                      <IconSpecSelect
                        icon={FlipHorizontal2}
                        label="Back print"
                        value={ln.backPrint}
                        options={['No', 'Yes']}
                        onChange={(v) => updateLine(idx, { backPrint: v })}
                      />
                    </td>
                    <td className={`${lineCellPad} align-middle`}>
                      <IconSpecSelect
                        icon={Layers}
                        label="Coating"
                        value={ln.coatingType}
                        options={COATING_TYPES}
                        onChange={(v) => updateLine(idx, { coatingType: v })}
                      />
                    </td>
                    <td className={`${lineCellPad} align-middle`}>
                      <IconSpecSelect
                        icon={Sparkles}
                        label="Emboss / leaf"
                        value={ln.embossingLeafing}
                        options={EMBOSSING_TYPES}
                        onChange={(v) => updateLine(idx, { embossingLeafing: v })}
                      />
                    </td>
                    <td className={`${lineCellPad} align-middle`}>
                      <IconSpecSelect
                        icon={Sun}
                        label="Foil"
                        value={ln.foilType}
                        options={FOIL_TYPES}
                        onChange={(v) => updateLine(idx, { foilType: v })}
                      />
                    </td>
                    <td className={lineCellPad}>
                      <input
                        type="text"
                        value={ln.remarks}
                        onChange={(e) => updateLine(idx, { remarks: e.target.value })}
                        className={`w-full min-w-0 ${inputCls}`}
                      />
                    </td>
                    <td className={`${lineCellPad} align-middle text-center`}>
                      <span title={paperMeta.title} className="inline-flex justify-center">
                        <FileText
                          className={`h-3.5 w-3.5 ${paperMeta.iconClassName}`}
                          strokeWidth={2}
                          aria-hidden
                        />
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      </fieldset>

      <div
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-border/40 bg-background/85 shadow-[0_-8px_32px_rgba(0,0,0,0.55)] backdrop-blur-md"
        aria-live="polite"
        aria-label="Purchase order financial summary"
      >
        <div className="mx-auto flex max-w-[1920px] flex-col gap-2 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              Supply
            </span>
            <div className="flex h-1.5 min-w-[120px] flex-1 max-w-md flex-row overflow-hidden rounded-full bg-ds-elevated ring-1 ring-ds-line/50">
              {supplyMaterialCounts.total > 0 ? (
                <>
                  <div
                    className="h-full flex-none bg-ds-line/30 transition-[width] duration-300"
                    style={{
                      width: `${(supplyMaterialCounts.grey / supplyMaterialCounts.total) * 100}%`,
                    }}
                  />
                  <div
                    className="h-full flex-none bg-sky-500 transition-[width] duration-300"
                    style={{
                      width: `${(supplyMaterialCounts.blue / supplyMaterialCounts.total) * 100}%`,
                    }}
                  />
                  <div
                    className="h-full flex-none bg-emerald-500 transition-[width] duration-300"
                    style={{
                      width: `${(supplyMaterialCounts.green / supplyMaterialCounts.total) * 100}%`,
                    }}
                  />
                </>
              ) : null}
            </div>
            <span className="text-[10px] tabular-nums text-ds-ink-faint">
              {supplyMaterialCounts.grey}/{supplyMaterialCounts.blue}/{supplyMaterialCounts.green}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1 text-[11px] text-ds-ink-muted">
              <span>
                Qty <span className={`${poMono} font-semibold text-ds-ink`}>{totalQty}</span>
              </span>
              <span>
                Subtotal{' '}
                <span className={`${poMono} font-semibold text-ds-ink`}>
                  ₹{subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </span>
              <span title="Sum of GST from each line (line rate × qty × GST %).">
                <span className="uppercase tracking-wide">GST (18%)</span>{' '}
                <span className={`${poMono} font-semibold text-ds-ink`}>
                  ₹{totalGst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </span>
              <span className="flex items-baseline gap-1.5 text-ds-ink-muted">
                <span className="text-[11px] font-medium uppercase tracking-wide">Grand total</span>
                <span
                  className={`${poMono} text-[1.2rem] font-bold leading-none text-[#f97316] sm:text-[1.35rem]`}
                >
                  ₹{grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => router.push('/orders/purchase-orders')}
                className="rounded-lg border border-ds-line/50 bg-ds-card/80 px-3 py-2 text-xs font-medium text-ds-ink hover:border-ds-line/50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="ci-btn-save-industrial rounded-lg px-5 py-2 text-xs font-semibold disabled:opacity-50"
              >
                {saving ? 'Saving…' : poSentToPlanning ? 'Save notes & exit' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Create Carton panel */}
      <SlideOverPanel title="Quick Create Carton" isOpen={qcCartonOpen} onClose={() => { setQcCartonOpen(false); setActiveCartonLineIndex(null) }}>
        <form onSubmit={submitQuickCreateCarton} className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-ds-ink-muted mb-1">Carton name<span className="text-red-400">*</span></label>
            <input
              type="text"
              value={qcCarton.cartonName}
              onChange={(e) => setQcCarton((prev) => ({ ...prev, cartonName: e.target.value }))}
              className={`w-full px-3 py-2 rounded bg-card border ${qcCartonErrors.cartonName ? 'border-red-500' : 'border-border'} text-foreground`}
            />
            {qcCartonErrors.cartonName && <p className="text-xs text-red-400 mt-1">{qcCartonErrors.cartonName}</p>}
          </div>
          <div>
            <label className="block text-xs text-ds-ink-muted mb-1">Artwork Code (AW)</label>
            <input
              type="text"
              value={qcCarton.artworkCode}
              onChange={(e) => setQcCarton((prev) => ({ ...prev, artworkCode: e.target.value.toUpperCase() }))}
              className="w-full px-3 py-2 rounded bg-card border border-border text-foreground font-mono"
              placeholder="e.g. AW-12345"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-ds-ink-muted mb-1">L</label>
              <input type="number" step={0.01} value={qcCarton.sizeL} onChange={(e) => setQcCarton((prev) => ({ ...prev, sizeL: e.target.value }))} className="w-full px-3 py-2 rounded bg-card border border-border text-foreground" />
            </div>
            <div>
              <label className="block text-xs text-ds-ink-muted mb-1">W</label>
              <input type="number" step={0.01} value={qcCarton.sizeW} onChange={(e) => setQcCarton((prev) => ({ ...prev, sizeW: e.target.value }))} className="w-full px-3 py-2 rounded bg-card border border-border text-foreground" />
            </div>
            <div>
              <label className="block text-xs text-ds-ink-muted mb-1">H</label>
              <input type="number" step={0.01} value={qcCarton.sizeH} onChange={(e) => setQcCarton((prev) => ({ ...prev, sizeH: e.target.value }))} className="w-full px-3 py-2 rounded bg-card border border-border text-foreground" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-ds-ink-muted mb-1">Rate</label>
              <input type="number" step={0.01} value={qcCarton.rate} onChange={(e) => setQcCarton((prev) => ({ ...prev, rate: e.target.value }))} className="w-full px-3 py-2 rounded bg-card border border-border text-foreground" />
            </div>
            <div>
              <label className="block text-xs text-ds-ink-muted mb-1">GST%</label>
              <input type="number" min={0} max={28} value={qcCarton.gstPct} onChange={(e) => setQcCarton((prev) => ({ ...prev, gstPct: e.target.value }))} className="w-full px-3 py-2 rounded bg-card border border-border text-foreground" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-ds-ink-muted mb-1">Board grade</label>
            <PackagingEnumCombobox
              aria-label="Board grade"
              options={BOARD_GRADES}
              value={qcCarton.boardGrade || null}
              onChange={(v) => setQcCarton((prev) => ({ ...prev, boardGrade: v ?? '' }))}
              controlClassName="border-ds-line/60 bg-ds-elevated hover:bg-ds-elevated/90 focus-within:ring-ds-line/30"
              inputClassName="text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-ds-ink-muted mb-1">GSM</label>
              <input type="number" value={qcCarton.gsm} onChange={(e) => setQcCarton((prev) => ({ ...prev, gsm: e.target.value }))} className="w-full px-3 py-2 rounded bg-card border border-border text-foreground" />
            </div>
            <div>
              <label className="block text-xs text-ds-ink-muted mb-1">Paper</label>
              <PackagingEnumCombobox
                aria-label="Paper / board"
                options={PAPER_TYPES}
                value={qcCarton.paperType || null}
                onChange={(v) => setQcCarton((prev) => ({ ...prev, paperType: v ?? '' }))}
                controlClassName="border-ds-line/60 bg-ds-elevated hover:bg-ds-elevated/90 focus-within:ring-ds-line/30"
                inputClassName="text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-ds-ink-muted mb-1">Coating / Emboss / Foil</label>
            <div className="mb-1">
              <PackagingEnumCombobox
                aria-label="Coating"
                options={COATING_TYPES}
                value={qcCarton.coatingType || null}
                onChange={(v) => setQcCarton((prev) => ({ ...prev, coatingType: v ?? '' }))}
                controlClassName="border-ds-line/60 bg-ds-elevated hover:bg-ds-elevated/90 focus-within:ring-ds-line/30"
                inputClassName="text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="mb-1">
              <PackagingEnumCombobox
                aria-label="Embossing"
                options={EMBOSSING_TYPES}
                value={qcCarton.embossingLeafing || null}
                onChange={(v) => setQcCarton((prev) => ({ ...prev, embossingLeafing: v ?? '' }))}
                controlClassName="border-ds-line/60 bg-ds-elevated hover:bg-ds-elevated/90 focus-within:ring-ds-line/30"
                inputClassName="text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <PackagingEnumCombobox
              aria-label="Foil"
              options={FOIL_TYPES}
              value={qcCarton.foilType || null}
              onChange={(v) => setQcCarton((prev) => ({ ...prev, foilType: v ?? '' }))}
              controlClassName="border-ds-line/60 bg-ds-elevated hover:bg-ds-elevated/90 focus-within:ring-ds-line/30"
              inputClassName="text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={qcCartonSaving} className="px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground text-sm font-medium">
              {qcCartonSaving ? 'Saving…' : 'Save Carton'}
            </button>
          </div>
        </form>
      </SlideOverPanel>
    </form>
  )
}
