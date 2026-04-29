'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import {
  mapApiRowToPoCarton,
  usePoRecentCartons,
  type PoCartonCatalogItem,
} from '@/lib/po-carton-autocomplete'
import { Copy, Star, Trash2 } from 'lucide-react'
import { PastingStyle } from '@prisma/client'
import { updateProductMasterStyle } from '@/lib/update-product-master-style'
import { PoNewLineItemDrawer } from '@/components/po/PoNewLineItemDrawer'
import { PoQuickCreateCartonForm } from '@/components/po/PoQuickCreateCartonForm'
import { Button } from '@/components/design-system/Button'
import { dataTable, DataTableFrame } from '@/components/design-system/DataTable'
import { cn } from '@/lib/cn'
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

const PO_FORM_TOOLING_AUDIT_ACTOR = 'Anik Dua'

type Line = {
  id?: string
  dieMasterId: string
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
  pastingStyle: string
  masterPastingStyleMissing: boolean
  ghostFromMaster: { size: boolean; gsm: boolean; pasting: boolean; rate: boolean }
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
  pastingStyle: '',
  masterPastingStyleMissing: false,
  ghostFromMaster: { size: false, gsm: false, pasting: false, rate: false },
  toolingDieType: '',
  toolingDims: '',
  toolingUnlinked: false,
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
    pastingStyle: '',
    masterPastingStyleMissing: false,
    ghostFromMaster: { size: false, gsm: false, pasting: false, rate: false },
    toolingDieType: '',
    toolingDims: '',
    toolingUnlinked: false,
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

function poPastingStyleFromMaster(c: CartonOption): PastingStyle {
  if (c.pastingStyle === PastingStyle.BSO) return PastingStyle.BSO
  return PastingStyle.LOCK_BOTTOM
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
        inputClassName="min-w-0 w-full max-w-full px-1.5 py-0.5 text-xs"
        dropdownClassName="min-w-[280px]"
      />
      {!line.cartonId && line.cartonName.trim() ? (
        <span className="mt-1 inline-block text-xs text-ds-warning">Unsaved carton name</span>
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
  const [detailLineIdx, setDetailLineIdx] = useState<number | null>(null)
  const [kbRowIndex, setKbRowIndex] = useState(0)
  const [masterPastePopoverLine, setMasterPastePopoverLine] = useState<number | null>(null)
  const [masterPasteSavingLine, setMasterPasteSavingLine] = useState<number | null>(null)

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
          const specOverrides = li.specOverrides && typeof li.specOverrides === 'object' ? li.specOverrides : ({} as Record<string, unknown>)
          const specPaste = specOverrides.pastingStyle as PastingStyle | string | undefined
          let pastingStyle = ''
          if (specPaste === PastingStyle.BSO) pastingStyle = 'BSO'
          else if (specPaste === PastingStyle.LOCK_BOTTOM) pastingStyle = 'LOCK_BOTTOM'
          const sizeForLine = String(li.cartonSize || '')
            .trim()
            .replace(/x/gi, '×')
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
            boardGrade: (specOverrides.boardGrade as string) || li.boardGrade || '',
            foilType: (specOverrides.foilType as string) || li.foilType || '',
            remarks: li.remarks || '',
            pastingStyle,
            masterPastingStyleMissing: false,
            ghostFromMaster: { size: false, gsm: false, pasting: false, rate: false },
            toolingDieType: li.lineDieType || '',
            toolingDims: sizeForLine,
            toolingUnlinked: false,
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
    const raw = (c.toolingDimsLabel || c.cartonSize || '').trim()
    const sizeForLine = raw.replace(/x/gi, '×')
    const autoPaste = poPastingStyleFromMaster(c)
    const masterPasteMissing = Boolean(c.id) && c.pastingStyle == null
    setLines((prev) =>
      prev.map((ln, i) =>
        i === idx
          ? {
              ...ln,
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
              dieMasterId: c.dieMasterId || c.dyeId || ln.dieMasterId,
              toolingDieType: c.masterDieType || '',
              toolingDims: sizeForLine,
              toolingUnlinked: !!c.toolingUnlinked,
              pastingStyle: autoPaste === PastingStyle.BSO ? 'BSO' : 'LOCK_BOTTOM',
              masterPastingStyleMissing: masterPasteMissing,
              ghostFromMaster: {
                size: true,
                gsm: true,
                pasting: !masterPasteMissing,
                rate: c.rate != null,
              },
            }
          : ln
      )
    )
    setFieldErrors((prev) => {
      const next = { ...prev }
      delete next.lines
      return next
    })
  }, [])

  const updateLine = (idx: number, patch: Partial<Line>) => {
    setLines((prev) => prev.map((ln, i) => (i === idx ? { ...ln, ...patch } : ln)))
  }

  const saveProductMasterPasting = async (
    lineIndex: number,
    cartonId: string,
    style: PastingStyle,
    opts?: { quiet?: boolean },
  ) => {
    if (!cartonId) return
    setMasterPasteSavingLine(lineIndex)
    try {
      const result = await updateProductMasterStyle(cartonId, style, {
        actorLabel: PO_FORM_TOOLING_AUDIT_ACTOR,
      })
      if (result.ok === false) throw new Error(result.error)
      const s = style === PastingStyle.BSO ? 'BSO' : 'LOCK_BOTTOM'
      setLines((prev) =>
        prev.map((ln, i) =>
          i === lineIndex
            ? {
                ...ln,
                pastingStyle: s,
                masterPastingStyleMissing: false,
                ghostFromMaster: { ...ln.ghostFromMaster, pasting: false },
              }
            : ln
        )
      )
      setCustomerCartons((prev) =>
        prev.map((c) => (c.id === cartonId ? { ...c, pastingStyle: style } : c))
      )
      setMasterPastePopoverLine(null)
      if (!opts?.quiet) toast.success('Product Master updated successfully.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
      if (opts?.quiet) throw e
    } finally {
      setMasterPasteSavingLine(null)
    }
  }

  const addLine = () =>
    setLines((prev) => {
      const next = [...prev, defaultLine()]
      setKbRowIndex(next.length - 1)
      return next
    })

  const removeLine = (idx: number) => {
    setMasterPastePopoverLine((openIdx) => {
      if (openIdx === idx) return null
      if (openIdx != null && openIdx > idx) return openIdx - 1
      return openIdx
    })
    setDetailLineIdx((open) => {
      if (open === null) return null
      if (open === idx) return null
      if (open > idx) return open - 1
      return open
    })
    setLines((prev) => prev.filter((_, i) => i !== idx))
  }

  const duplicateLine = (idx: number) => {
    setLines((prev) => {
      const ln = prev[idx]
      if (!ln) return prev
      const copy = structuredClone(ln) as Line
      copy.id = undefined
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)]
    })
    setMasterPastePopoverLine((open) => {
      if (open === null) return null
      return open > idx ? open + 1 : open
    })
    setDetailLineIdx((open) => {
      if (open === null) return null
      if (open > idx) return open + 1
      return open
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
              ...(l.pastingStyle === 'BSO' || l.pastingStyle === 'LOCK_BOTTOM'
                ? { pastingStyle: l.pastingStyle === 'BSO' ? PastingStyle.BSO : PastingStyle.LOCK_BOTTOM }
                : {}),
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

  const inputCls =
    'ds-input w-full min-w-0 border-ds-line/80 bg-ds-elevated/60 dark:bg-ds-elevated/80 text-sm text-ds-ink placeholder:text-ds-ink-faint'
  const inputClsGhost =
    'ds-input w-full min-w-0 !border-ds-line/50 !bg-ds-elevated/40 dark:!bg-ds-elevated/60 !text-ds-ink-muted placeholder:text-ds-ink-faint'
  const inputErr = 'ring-1 ring-ds-error/40 !border-ds-error/60'
  const lineCellPad = `${dataTable.td.base} align-middle min-h-[52px]`
  const poMono = 'po-mono-metric'
  const tableInputPrimary = 'text-sm font-semibold text-ds-ink tabular-nums'
  const tableInputSecondary = 'text-sm font-medium text-ds-ink-muted'
  const thPrimary = 'text-left text-sm font-semibold tracking-tight text-ds-ink'
  const thSecondary = 'text-left text-sm font-medium uppercase tracking-wider text-ds-ink-muted'

  if (loading) {
    return (
      <div className="min-h-[40vh] bg-background p-4 text-ds-ink-muted">Loading…</div>
    )
  }

  return (
    <form
      onSubmit={handleSave}
      className="min-h-screen bg-background px-3 py-3 sm:px-4 space-y-3 pb-36 max-w-[1920px] mx-auto w-full"
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
              className={`mt-0.5 w-full min-w-[10rem] max-w-[16rem] border-b-2 border-transparent bg-transparent font-mono text-lg font-bold text-ds-warning focus:border-ds-brand focus:outline-none ${fieldErrors.poNumber ? 'ring-1 ring-red-500/60' : ''} ${poSentToPlanning ? 'cursor-not-allowed opacity-80' : ''}`}
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
                className="mt-1 w-full min-w-[10rem] rounded-lg border border-ds-line/40 bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-ds-brand focus:outline-none focus:ring-1 focus:ring-ds-brand/40 sm:text-right enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-80"
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
                  <p className="text-right text-xs text-ds-warning/90 sm:max-w-[16rem]">
                    Set status to Confirmed or Approved to release to Planning.
                  </p>
                ) : null}
                {releaseStatusOk && !productionKitLoading && productionKit && !productionKit.allOk ? (
                  <label className="flex cursor-pointer items-center justify-end gap-2 text-xs text-ds-warning">
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
                  <p className="text-right text-xs text-ds-warning/90">Link every line to a master product to release.</p>
                ) : null}
                {releaseStatusOk && (!deliveryRequiredBy.trim() || !poDate.trim()) ? (
                  <p className="text-right text-xs text-ds-warning/90">PO date and delivery date are required.</p>
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
              <p className="text-right text-xs leading-snug text-emerald-400/90">
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
                inputClassName="min-w-0 w-full border border-ds-line/40 bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-ds-brand focus:ring-1 focus:ring-ds-brand/40"
              />
            </div>
            {selectedCustomer ? (
              <p className="mt-1 text-xs text-ds-ink-faint">
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
              className="mt-1 w-full rounded-lg border border-ds-line/40 bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-ds-brand focus:outline-none focus:ring-1 focus:ring-ds-brand/40"
            />
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted">Delivery</div>
            <input
              type="date"
              value={deliveryRequiredBy}
              onChange={(e) => setDeliveryRequiredBy(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ds-line/40 bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-ds-brand focus:outline-none focus:ring-1 focus:ring-ds-brand/40"
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
              className="mt-1 w-full rounded-lg border border-ds-line/40 bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-ds-brand focus:outline-none focus:ring-1 focus:ring-ds-brand/40"
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
              className="mt-1 w-full rounded-lg border border-ds-line/40 bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:border-ds-brand focus:outline-none focus:ring-1 focus:ring-ds-brand/40"
            />
        </div>
      </div>

      <ProductionReadinessBar
        lines={productionKit?.lines ?? []}
        allOk={productionKit?.allOk ?? false}
        anyRose={productionKit?.anyRose ?? false}
        loading={productionKitLoading}
      />

      {/* Line items — same summary table + drawer as Create PO */}
      <fieldset disabled={poSentToPlanning} className="min-w-0 border-0 p-0">
        <div className="space-y-4 rounded-ds-lg border border-ds-line/80 bg-ds-card/30 p-4 text-sm shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="ds-typo-label font-semibold uppercase tracking-wider text-ds-ink-faint">Line items</p>
            <Button type="button" variant="secondary" onClick={addLine}>
              + Add line
            </Button>
          </div>
          {fieldErrors.lines ? <p className="text-xs text-ds-error">{fieldErrors.lines}</p> : null}

          <DataTableFrame className="max-h-[min(calc(100vh-18rem),640px)] min-h-[240px] border-ds-line/60 bg-ds-elevated/20">
            <div className={dataTable.wrap}>
              <table className={dataTable.table}>
                <thead className={dataTable.thead}>
                  <tr>
                    <th
                      className={`${dataTable.th} w-[40%] sticky left-0 z-40 min-h-[48px] border-r border-ds-line/50 bg-ds-elevated/95 shadow-[2px_0_8px_rgba(0,0,0,0.2)] pr-2 text-left text-xs font-semibold text-ds-ink`}
                    >
                      Carton
                    </th>
                    <th className={`${lineCellPad} ${thSecondary} w-[11%] ${poMono}`}>Size</th>
                    <th className={`${lineCellPad} ${thPrimary} w-[9%] text-center ${poMono}`}>Qty *</th>
                    <th className={`${lineCellPad} ${thPrimary} w-[18%] text-right ${poMono}`}>Rate</th>
                    <th className={`${lineCellPad} ${thPrimary} w-[16%] text-right ${poMono}`}>Amount</th>
                    <th
                      className={`${lineCellPad} w-[6%] text-right text-xs font-normal text-ds-ink-faint`}
                      aria-label="Row actions"
                    />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((ln, idx) => {
                    const rate = Number(ln.rate) || 0
                    const qty = Number(ln.quantity) || 0
                    const gstPct = Number(ln.gstPct) || 0
                    const { beforeGst } = lineAmount(rate, qty, gstPct)
                    const amount = beforeGst
                    const rowStripe = idx % 2 === 0 ? 'bg-ds-main/40' : 'bg-ds-elevated/25'
                    const stickBg = rowStripe
                    return (
                      <tr
                        key={ln.id ?? idx}
                        onMouseEnter={() => setKbRowIndex(idx)}
                        onClick={(e) => {
                          if (poSentToPlanning) return
                          if ((e.target as HTMLElement).closest('input, select, button, a, [data-line-stop]')) return
                          setKbRowIndex(idx)
                          setDetailLineIdx(idx)
                        }}
                        className={cn(
                          'group min-h-[52px] border-b border-ds-line/30',
                          dataTable.tr.body,
                          dataTable.tr.hover,
                          rowStripe,
                          !poSentToPlanning && 'cursor-pointer',
                          detailLineIdx === null && kbRowIndex === idx
                            ? 'ring-1 ring-ds-brand/35 ring-inset'
                            : '',
                          detailLineIdx === idx && 'bg-ds-brand/8 ring-1 ring-inset ring-ds-brand/30',
                        )}
                        title={
                          poSentToPlanning
                            ? undefined
                            : 'Click row for material, printing, and costing'
                        }
                      >
                        <td
                          className={cn(
                            lineCellPad,
                            'align-top',
                            stickBg,
                            'sticky left-0 z-20 max-w-0 border-r border-ds-line/50 shadow-[2px_0_8px_rgba(0,0,0,0.12)] transition-colors group-hover:bg-ds-elevated/20',
                          )}
                        >
                          <div data-line-stop className="min-w-0" onClick={(e) => e.stopPropagation()}>
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
                                setQcCarton((prev) => ({ ...prev, cartonName: suggestedName.trim() }))
                                setQcCartonOpen(true)
                                setLines((prev) => {
                                  const cur = prev[idx]
                                  if (!cur) return prev
                                  const next = [...prev]
                                  next[idx] = resetAutofillFields(cur, suggestedName)
                                  return next
                                })
                              }}
                            />
                          </div>
                        </td>
                        <td
                          className={cn(
                            lineCellPad,
                            ln.ghostFromMaster.size ? 'po-master-field-pulse' : '',
                            'align-top',
                          )}
                        >
                          <div data-line-stop onClick={(e) => e.stopPropagation()}>
                            <input
                              type="text"
                              value={ln.cartonSize}
                              onChange={(e) => {
                                const v = e.target.value
                                updateLine(idx, {
                                  cartonSize: v,
                                  toolingDims: v,
                                  ghostFromMaster: { ...ln.ghostFromMaster, size: false },
                                })
                              }}
                              className={cn(
                                'w-full min-w-0 max-w-full truncate',
                                ln.ghostFromMaster.size ? inputClsGhost : inputCls,
                                tableInputSecondary,
                                poMono,
                              )}
                              title={ln.cartonSize}
                              placeholder="L×W×H"
                            />
                          </div>
                        </td>
                        <td
                          className={cn(lineCellPad, 'text-center align-top')}
                          data-line-stop
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="number"
                            min={1}
                            value={ln.quantity}
                            onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                            className={cn(
                              'inline-block w-16 min-w-0 text-center',
                              inputCls,
                              tableInputPrimary,
                              poMono,
                            )}
                          />
                        </td>
                        <td
                          className={cn(lineCellPad, 'text-right align-top')}
                          data-line-stop
                          onClick={(e) => e.stopPropagation()}
                          title={
                            ln.ghostFromMaster.rate
                              ? 'From Product Master — edit in line details to override'
                              : 'Rate per unit (ex-GST)'
                          }
                        >
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={ln.rate}
                            onChange={(e) =>
                              updateLine(idx, {
                                rate: e.target.value,
                                ghostFromMaster: { ...ln.ghostFromMaster, rate: false },
                              })
                            }
                            className={cn(
                              'inline-block w-full min-w-0 max-w-[6.5rem] text-right',
                              ln.ghostFromMaster.rate ? inputClsGhost : inputCls,
                              tableInputPrimary,
                              poMono,
                            )}
                          />
                        </td>
                        <td
                          className={cn(
                            lineCellPad,
                            'text-right align-top text-base font-bold tabular-nums text-ds-success',
                            poMono,
                          )}
                        >
                          {amount.toFixed(2)}
                        </td>
                        <td
                          className={cn(lineCellPad, 'text-right align-middle')}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="inline-flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              type="button"
                              title={ln.directorPriority ? 'Clear director priority' : 'Director priority'}
                              onClick={() => updateLine(idx, { directorPriority: !ln.directorPriority })}
                              className={cn(
                                'rounded-ds-sm p-1.5 transition-colors',
                                ln.directorPriority
                                  ? 'text-ds-warning hover:bg-ds-elevated'
                                  : 'text-ds-ink-muted hover:bg-ds-elevated hover:text-ds-ink',
                              )}
                            >
                              <Star
                                className={cn('h-3.5 w-3.5', ln.directorPriority && 'fill-ds-warning text-ds-warning')}
                                strokeWidth={2}
                              />
                            </button>
                            <button
                              type="button"
                              title="Duplicate"
                              onClick={() => duplicateLine(idx)}
                              className="rounded-ds-sm p-1.5 text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-brand"
                            >
                              <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                            </button>
                            {lines.length > 1 ? (
                              <button
                                type="button"
                                title="Remove"
                                onClick={() => removeLine(idx)}
                                className="rounded-ds-sm p-1.5 text-ds-error/80 transition hover:bg-ds-error/10"
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
          </DataTableFrame>
        </div>
      </fieldset>

      <div
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-border/40 bg-background/85 shadow-[0_-8px_32px_rgba(0,0,0,0.55)] backdrop-blur-md"
        aria-live="polite"
        aria-label="Purchase order financial summary"
      >
        <div className="mx-auto flex max-w-[1920px] flex-col gap-2 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
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
            <span className="text-xs tabular-nums text-ds-ink-faint">
              {supplyMaterialCounts.grey}/{supplyMaterialCounts.blue}/{supplyMaterialCounts.green}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-ds-ink-muted">
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
                <span className="text-xs font-medium uppercase tracking-wide">Grand total</span>
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
      <PoNewLineItemDrawer
        isOpen={!poSentToPlanning && detailLineIdx != null}
        onClose={() => setDetailLineIdx(null)}
        lineIndex={detailLineIdx ?? 0}
        line={!poSentToPlanning && detailLineIdx != null ? (lines[detailLineIdx] ?? null) : null}
        updateLine={updateLine}
        fieldErrors={fieldErrors}
        inputCls={inputCls}
        inputClsGhost={inputClsGhost}
        inputErr={inputErr}
        poMono={poMono}
        masterPasteSavingLine={masterPasteSavingLine}
        masterPastePopoverLine={masterPastePopoverLine}
        setMasterPastePopoverLine={setMasterPastePopoverLine}
        onSavePastingToMaster={(i, cid, s) => void saveProductMasterPasting(i, cid, s)}
      />

      <SlideOverPanel title="Quick Create Carton" isOpen={qcCartonOpen} onClose={() => { setQcCartonOpen(false); setActiveCartonLineIndex(null) }}>
        <PoQuickCreateCartonForm
          values={qcCarton}
          setValues={setQcCarton}
          errors={qcCartonErrors}
          saving={qcCartonSaving}
          onSubmit={submitQuickCreateCarton}
        />
      </SlideOverPanel>
    </form>
  )
}
