'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from '@/store/toastStore'
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
import { cn } from '@/lib/cn'
import { parseDeliveryYmdFromRemarks } from '@/lib/po-delivery-parse'
import { broadcastIndustrialPriorityChange } from '@/lib/industrial-priority-sync'
import { ProductionReadinessBar } from '@/components/orders/ProductionReadinessBar'
import type { ProductionKitForLine } from '@/lib/production-kit-status'
import type { SpecPackV1 } from '@/lib/carton-spec-pack'
import {
  seedLineFromSpecPack,
  applySpecOverrideEdit,
  type EditableSpecField,
  type SpecOverrides,
  type SpecProvenance,
  type SpecSeedLine,
} from '@/lib/po-line-specpack'

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
  printingType: string
  numberOfColours: string
  sheetSizeL: string
  sheetSizeW: string
  ups: string
  spotUv: string
  braille: string
  embossing: string
  leafing: string
  remarks: string
  pastingStyle: string
  masterPastingStyleMissing: boolean
  ghostFromMaster: { size: boolean; gsm: boolean; pasting: boolean; rate: boolean }
  toolingDieType: string
  toolingDims: string
  toolingUnlinked: boolean
  fgReservation?: {
    reservationKey: string
    materialId: string
    materialCode: string
    qtyReserved: number
    unit: string
    movementId: string
    reservedAt: string
  } | null
  useReservedFirst?: boolean
  specPackBase?: SpecPackV1 | null
  specPackLegacy?: boolean
  specOverrides?: SpecOverrides
  specProvenance?: Partial<Record<EditableSpecField, SpecProvenance>>
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
  printingType: '',
  numberOfColours: '',
  sheetSizeL: '',
  sheetSizeW: '',
  ups: '',
  spotUv: '',
  braille: '',
  embossing: '',
  leafing: '',
  remarks: '',
  pastingStyle: '',
  masterPastingStyleMissing: false,
  ghostFromMaster: { size: false, gsm: false, pasting: false, rate: false },
  toolingDieType: '',
  toolingDims: '',
  toolingUnlinked: false,
  specPackBase: undefined,
  specPackLegacy: false,
  specOverrides: null,
  specProvenance: {},
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
    printingType: '',
    numberOfColours: '',
    sheetSizeL: '',
    sheetSizeW: '',
    ups: '',
    spotUv: '',
    braille: '',
    embossing: '',
    leafing: '',
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
        inputClassName="h-9 min-w-0 w-full max-w-full px-2 text-sm"
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
    pastingType: '',
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
        const res = await fetch(`/api/cartons?customerId=${encodeURIComponent(customerId)}&limit=280`)
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

  // Backfill size and artwork code from the carton master for lines saved
  // without a snapshot. Mirrors applyCartonToLine's master-derived values and
  // only fills empty fields, so operator edits are never overwritten.
  useEffect(() => {
    if (customerCartonsLoading || customerCartons.length === 0) return
    const byId = new Map(customerCartons.map((c) => [c.id, c]))
    setLines((prev) => {
      let changed = false
      const next = prev.map((ln) => {
        if (!ln.cartonId) return ln
        const master = byId.get(ln.cartonId)
        if (!master) return ln
        const masterSize = (master.toolingDimsLabel || master.cartonSize || '')
          .trim()
          .replace(/x/gi, '×')
        const patch: Partial<Line> = {}
        if (!ln.cartonSize.trim() && masterSize) patch.cartonSize = masterSize
        if (!ln.toolingDims.trim() && masterSize) patch.toolingDims = masterSize
        if (!ln.artworkCode.trim() && master.artworkCode) patch.artworkCode = master.artworkCode
        if (Object.keys(patch).length === 0) return ln
        changed = true
        return { ...ln, ...patch }
      })
      return changed ? next : prev
    })
  }, [customerCartons, customerCartonsLoading])

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
            printingType: (specOverrides.printingType as string) || li.printingType || '',
            numberOfColours:
              specOverrides.numberOfColours != null ? String(specOverrides.numberOfColours) : '',
            sheetSizeL: specOverrides.sheetSizeL != null ? String(specOverrides.sheetSizeL) : '',
            sheetSizeW: specOverrides.sheetSizeW != null ? String(specOverrides.sheetSizeW) : '',
            ups: specOverrides.ups != null ? String(specOverrides.ups) : '',
            spotUv: specOverrides.spotUv === true ? 'Yes' : specOverrides.spotUv === false ? 'No' : '',
            braille: specOverrides.braille === true ? 'Yes' : specOverrides.braille === false ? 'No' : '',
            embossing: specOverrides.embossing === true ? 'Yes' : specOverrides.embossing === false ? 'No' : '',
            leafing: specOverrides.leafing === true ? 'Yes' : specOverrides.leafing === false ? 'No' : '',
            remarks: li.remarks || '',
            pastingStyle,
            masterPastingStyleMissing: false,
            ghostFromMaster: { size: false, gsm: false, pasting: false, rate: false },
            toolingDieType: li.lineDieType || '',
            toolingDims: sizeForLine,
            toolingUnlinked: false,
            fgReservation:
              specOverrides.fgReservation && typeof specOverrides.fgReservation === 'object'
                ? (specOverrides.fgReservation as Line['fgReservation'])
                : null,
            useReservedFirst: specOverrides.useReservedFirst !== false,
            specPackBase: undefined,
            specPackLegacy: false,
            specOverrides: (specOverrides && (specOverrides as Record<string, unknown>).specPack)
              ? { specPack: (specOverrides as Record<string, unknown>).specPack as Record<string, Record<string, unknown>> }
              : null,
            specProvenance: {},
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
              // Re-fetch the carton's spec pack so Printing/Colours/Sheet/UPS/finishing
              // flags populate from the current master on (re)link.
              specPackBase: undefined,
              specPackLegacy: false,
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

  const updateLineField = useCallback(
    (idx: number, field: EditableSpecField, value: string) => {
      setLines((prev) =>
        prev.map((ln, i) => {
          if (i !== idx) return ln
          const seedLine: SpecSeedLine = {
            boardGrade: ln.boardGrade,
            gsm: ln.gsm,
            paperType: ln.paperType,
            coatingType: ln.coatingType,
            embossingLeafing: ln.embossingLeafing,
            foilType: ln.foilType,
            pastingStyle: ln.pastingStyle,
            backPrint: ln.backPrint,
            artworkCode: ln.artworkCode,
            printingType: ln.printingType,
            numberOfColours: ln.numberOfColours,
            sheetSizeL: ln.sheetSizeL,
            sheetSizeW: ln.sheetSizeW,
            ups: ln.ups,
            spotUv: ln.spotUv,
            braille: ln.braille,
            embossing: ln.embossing,
            leafing: ln.leafing,
            specOverrides: ln.specOverrides ?? null,
            specProvenance: ln.specProvenance ?? {},
          }
          const next: Line = { ...ln, [field]: value } as Line
          if (ln.specPackBase) {
            const { specOverrides, specProvenance } = applySpecOverrideEdit(seedLine, field, value)
            next.specOverrides = specOverrides
            next.specProvenance = specProvenance
          }
          return next
        }),
      )
    },
    [],
  )

  const specPackCache = useRef<Map<string, { pack: SpecPackV1 | null; lastPoPack: SpecPackV1 | null }>>(new Map())

  useEffect(() => {
    let cancelled = false
    lines.forEach((ln, idx) => {
      if (!ln.cartonId) return
      if (ln.specPackBase !== undefined) return
      const cartonId = ln.cartonId
      const cached = specPackCache.current.get(cartonId)
      const apply = (pack: SpecPackV1 | null, lastPoPack: SpecPackV1 | null) => {
        if (cancelled) return
        setLines((prev) =>
          prev.map((cur, i) => {
            if (i !== idx || cur.cartonId !== cartonId) return cur
            if (pack == null) {
              // No spec pack available — if the line itself has no pasting
              // style stored, treat it as missing so the UI prompts the user
              // instead of spinning on "Loading…".
              const pastingMissing = !cur.pastingStyle?.trim()
              return {
                ...cur,
                specPackBase: null,
                specPackLegacy: true,
                masterPastingStyleMissing: pastingMissing,
              }
            }
            const seedLine: SpecSeedLine = {
              boardGrade: cur.boardGrade,
              gsm: cur.gsm,
              paperType: cur.paperType,
              coatingType: cur.coatingType,
              embossingLeafing: cur.embossingLeafing,
              foilType: cur.foilType,
              pastingStyle: cur.pastingStyle,
              backPrint: cur.backPrint,
              artworkCode: cur.artworkCode,
              printingType: cur.printingType,
              numberOfColours: cur.numberOfColours,
              sheetSizeL: cur.sheetSizeL,
              sheetSizeW: cur.sheetSizeW,
              ups: cur.ups,
              spotUv: cur.spotUv,
              braille: cur.braille,
              embossing: cur.embossing,
              leafing: cur.leafing,
              specOverrides: cur.specOverrides ?? null,
              specProvenance: cur.specProvenance ?? {},
            }
            const { patch, provenance } = seedLineFromSpecPack(seedLine, pack, cur.specOverrides ?? null, lastPoPack)
            const seededPaste = patch.pastingStyle ?? cur.pastingStyle
            const packPaste = pack.tooling?.pastingStyle
            const pastingMissing =
              !seededPaste?.trim() && (packPaste == null || String(packPaste).trim() === '')
            return {
              ...cur,
              ...patch,
              specPackBase: pack,
              specPackLegacy: false,
              specProvenance: { ...(cur.specProvenance ?? {}), ...provenance },
              masterPastingStyleMissing: pastingMissing,
            }
          }),
        )
      }
      if (cached) { apply(cached.pack, cached.lastPoPack); return }
      void (async () => {
        try {
          const url = `/api/cartons/${encodeURIComponent(cartonId)}/spec-pack?excludePoId=${encodeURIComponent(id)}${
            customerId ? `&customerId=${encodeURIComponent(customerId)}` : ''
          }`
          const res = await fetch(url)
          if (!res.ok) { specPackCache.current.set(cartonId, { pack: null, lastPoPack: null }); apply(null, null); return }
          const data = (await res.json()) as { pack?: SpecPackV1; lastPoPack?: SpecPackV1 | null }
          const pack = data.pack && (data.pack as { v?: number }).v === 1 ? data.pack : null
          const lastPoPack = data.lastPoPack && (data.lastPoPack as { v?: number }).v === 1 ? data.lastPoPack : null
          specPackCache.current.set(cartonId, { pack, lastPoPack })
          apply(pack, lastPoPack)
        } catch {
          specPackCache.current.set(cartonId, { pack: null, lastPoPack: null })
          apply(null, null)
        }
      })()
    })
    return () => { cancelled = true }
  }, [lines])

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
              printingType: l.printingType.trim() || undefined,
              numberOfColours: l.numberOfColours.trim() ? Number(l.numberOfColours) : undefined,
              sheetSizeL: l.sheetSizeL.trim() ? Number(l.sheetSizeL) : undefined,
              sheetSizeW: l.sheetSizeW.trim() ? Number(l.sheetSizeW) : undefined,
              ups: l.ups.trim() ? Number(l.ups) : undefined,
              spotUv: l.spotUv === 'Yes' ? true : l.spotUv === 'No' ? false : undefined,
              braille: l.braille === 'Yes' ? true : l.braille === 'No' ? false : undefined,
              embossing: l.embossing === 'Yes' ? true : l.embossing === 'No' ? false : undefined,
              leafing: l.leafing === 'Yes' ? true : l.leafing === 'No' ? false : undefined,
              fgReservation: l.fgReservation ?? undefined,
              useReservedFirst: l.useReservedFirst !== false,
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
    e.stopPropagation()
    if (!customerId) { toast.error('Select a customer first'); return }
    const next: Record<string, string> = {}
    if (!qcCarton.cartonName.trim()) next.cartonName = 'Carton name is required'
    if (!qcCarton.sizeL.trim() || Number(qcCarton.sizeL) <= 0) next.sizeL = 'Length is required'
    if (!qcCarton.sizeW.trim() || Number(qcCarton.sizeW) <= 0) next.sizeW = 'Width is required'
    if (!qcCarton.sizeH.trim() || Number(qcCarton.sizeH) <= 0) next.sizeH = 'Height is required'
    if (!qcCarton.boardGrade.trim()) next.boardGrade = 'Board grade is required'
    if (!qcCarton.gsm.trim() || Number(qcCarton.gsm) <= 0) next.gsm = 'GSM is required'
    setQcCartonErrors(next)
    if (Object.keys(next).length) {
      toast.error('Please fill all mandatory carton fields')
      return
    }
    if (qcCartonSaving) return
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
        pastingType: qcCarton.pastingType || undefined,
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
        if (data?.fields && typeof data.fields === 'object') {
          setQcCartonErrors((data.fields as Record<string, string>) ?? {})
        }
        console.error('[QuickCreateCarton] create failed', data)
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
        specialInstructions: created.specialInstructions ?? null,
      }
      const refreshRes = await fetch(`/api/cartons?customerId=${encodeURIComponent(customerId)}&limit=280`)
      const refreshJson = (await refreshRes.json().catch(() => [])) as Record<string, unknown>[]
      const refreshed = Array.isArray(refreshJson) ? refreshJson.map(mapApiRowToPoCarton) : []
      if (refreshed.length > 0) {
        setCustomerCartons(refreshed)
      } else {
        setCustomerCartons((prev) => {
          if (prev.some((p) => p.id === formatted.id)) return prev
          return [...prev, formatted].sort((a, b) => a.cartonName.localeCompare(b.cartonName))
        })
      }

      const targetIndex =
        activeCartonLineIndex != null
          ? activeCartonLineIndex
          : detailLineIdx != null
            ? detailLineIdx
            : kbRowIndex

      if (targetIndex < 0 || targetIndex >= lines.length) {
        toast.error('Carton created, but could not map to current PO line')
        return
      }

      applyCartonToLine(targetIndex, formatted)
      setQcCartonOpen(false)
      setActiveCartonLineIndex(null)
      setQcCarton({ cartonName: '', artworkCode: '', sizeL: '', sizeW: '', sizeH: '', rate: '', gstPct: '5', boardGrade: '', gsm: '', paperType: '', coatingType: '', embossingLeafing: '', foilType: '', pastingType: '' })
      toast.success('Carton created and added to PO')
    } catch (err) {
      console.error('[QuickCreateCarton] unexpected error', err)
      toast.error(err instanceof Error ? err.message : 'Failed to create carton')
    } finally {
      setQcCartonSaving(false)
    }
  }

  const inputCls =
    'ds-input w-full min-w-0 border-ds-line/80 bg-ds-elevated/60 dark:bg-ds-elevated/80 text-sm text-ds-ink placeholder:text-ds-ink-faint'
  const inputClsGhost =
    'ds-input w-full min-w-0 !border-ds-line/50 !bg-ds-elevated/40 dark:!bg-ds-elevated/60 !text-ds-ink-muted placeholder:text-ds-ink-faint'
  const inputErr = 'ring-1 ring-ds-error/40 !border-ds-error/60'
  const poMono = 'po-mono-metric'
  const tableInputPrimary = 'h-9 text-sm font-semibold leading-9 text-ds-ink tabular-nums'
  const tableInputSecondary = 'h-9 text-sm font-medium leading-9 text-ds-ink-muted'

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
      <div className="rounded-ds-lg bg-card/30 px-3 py-3 backdrop-blur-md shadow-ds-depth-sm sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
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
              className={`mt-0.5 w-full min-w-[10rem] max-w-[16rem] border-b-2 border-transparent bg-transparent font-mono text-lg font-bold text-[var(--brand-primary)] focus:border-ds-brand focus:outline-none ${fieldErrors.poNumber ? 'ring-1 ring-[var(--error)]/60' : ''} ${poSentToPlanning ? 'cursor-not-allowed opacity-80' : ''}`}
            />
            {fieldErrors.poNumber ? (
              <span className="mt-0.5 block text-xs text-[var(--error)]">{fieldErrors.poNumber}</span>
            ) : null}
          </div>
          <div className="flex shrink-0 max-w-md flex-col items-stretch gap-2 sm:items-end">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted sm:text-right">Status</div>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={poSentToPlanning}
                className="mt-1 w-full min-w-[10rem] rounded-ds-md bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand/40 sm:text-right enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-80"
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
                  className="w-full rounded-ds-md bg-[var(--brand-primary)] px-3 py-2 text-xs font-bold text-white shadow transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                >
                  {releasingToPlanning ? 'Releasing…' : 'Release to Planning'}
                </button>
              </div>
            ) : (
              <p className="text-right text-xs leading-snug text-[var(--success)]/90">
                In Planning — lines are read-only.{' '}
                <Link href="/orders/planning" className="font-semibold text-[var(--brand-primary)] underline underline-offset-2">
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
                inputClassName="min-w-0 w-full bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:ring-1 focus:ring-ds-brand/40"
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
              className="mt-1 w-full rounded-ds-md bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand/40"
            />
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ds-ink-muted">Delivery</div>
            <input
              type="date"
              value={deliveryRequiredBy}
              onChange={(e) => setDeliveryRequiredBy(e.target.value)}
              className="mt-1 w-full rounded-ds-md bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand/40"
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
              className="mt-1 w-full rounded-ds-md bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand/40"
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
              className="mt-1 w-full rounded-ds-md bg-ds-elevated/60 dark:bg-ds-elevated/80 px-2 py-1.5 text-xs font-bold text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand/40"
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
        <div className="space-y-4 rounded-ds-lg bg-ds-card/30 p-4 text-sm shadow-ds-depth-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="ds-typo-label font-semibold uppercase tracking-wider text-ds-ink-faint">Line items</p>
            <Button type="button" variant="secondary" onClick={addLine}>
              + Add line
            </Button>
          </div>
          {fieldErrors.lines ? <p className="text-xs text-ds-error">{fieldErrors.lines}</p> : null}

          <div className="rounded-ds-md bg-ds-elevated/20 p-4">
            <div className="grid items-center gap-x-3 pb-2 text-xs font-semibold uppercase tracking-wider text-ds-ink-muted" style={{ gridTemplateColumns: '48px minmax(340px,1.8fr) minmax(140px,.7fr) 110px 120px 140px 80px' }}>
              <div className="text-center">S.No</div>
              <div>Carton</div>
              <div>Size</div>
              <div className="text-center">Qty *</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Amount</div>
              <div className="text-right">Actions</div>
            </div>
            <div className="space-y-2">
                  {lines.map((ln, idx) => {
                    const rate = Number(ln.rate) || 0
                    const qty = Number(ln.quantity) || 0
                    const gstPct = Number(ln.gstPct) || 0
                    const { beforeGst } = lineAmount(rate, qty, gstPct)
                    const amount = beforeGst
                    const rowStripe = idx % 2 === 0 ? 'bg-ds-main/40' : 'bg-ds-elevated/25'
                    return (
                      <div
                        key={ln.id ?? idx}
                        onMouseEnter={() => setKbRowIndex(idx)}
                        onClick={(e) => {
                          if (poSentToPlanning) return
                          if ((e.target as HTMLElement).closest('input, select, button, a, [data-line-stop]')) return
                          setKbRowIndex(idx)
                          setDetailLineIdx(idx)
                        }}
                        className={cn(
                          'group grid items-start gap-x-3 rounded-ds-md px-3 py-2',
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
                        style={{ gridTemplateColumns: '48px minmax(340px,1.8fr) minmax(140px,.7fr) 110px 120px 140px 80px' }}
                      >
                        <div className="pt-2 text-center text-sm font-semibold tabular-nums text-ds-ink-muted">
                          {idx + 1}
                        </div>
                        <div className="min-w-0">
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
                        </div>
                        <div className={cn(ln.ghostFromMaster.size ? 'po-master-field-pulse' : '', 'min-w-0')}>
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
                        </div>
                        <div className="text-center" data-line-stop onClick={(e) => e.stopPropagation()}>
                          <input
                            type="number"
                            min={1}
                            value={ln.quantity}
                            onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                            className={cn(
                              'inline-block h-9 w-24 min-w-0 text-center',
                              inputCls,
                              tableInputPrimary,
                              poMono,
                            )}
                          />
                        </div>
                        <div
                          className="text-right"
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
                              'inline-block h-9 w-full min-w-0 max-w-[7.5rem] text-right',
                              ln.ghostFromMaster.rate ? inputClsGhost : inputCls,
                              tableInputPrimary,
                              poMono,
                            )}
                          />
                        </div>
                        <div className={cn('pt-2 text-right text-base font-bold tabular-nums text-ds-success', poMono)}>
                          {amount.toFixed(2)}
                        </div>
                        <div className="pt-1 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex items-center justify-end gap-1.5 opacity-100">
                            <button
                              type="button"
                              title={ln.directorPriority ? 'Clear director priority' : 'Director priority'}
                              onClick={() => updateLine(idx, { directorPriority: !ln.directorPriority })}
                              className={cn(
                                'flex h-7 w-7 items-center justify-center rounded transition-colors',
                                ln.directorPriority
                                  ? 'text-ds-warning hover:bg-ds-elevated'
                                  : 'text-ds-ink-muted hover:bg-ds-elevated hover:text-ds-ink',
                              )}
                            >
                              <Star
                                className={cn('h-4 w-4', ln.directorPriority && 'fill-ds-warning text-ds-warning')}
                                strokeWidth={2}
                              />
                            </button>
                            <button
                              type="button"
                              title="Duplicate"
                              onClick={() => duplicateLine(idx)}
                              className="flex h-7 w-7 items-center justify-center rounded text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-brand"
                            >
                              <Copy className="h-4 w-4" strokeWidth={2} />
                            </button>
                            {lines.length > 1 ? (
                              <button
                                type="button"
                                title="Remove"
                                onClick={() => removeLine(idx)}
                                className="flex h-7 w-7 items-center justify-center rounded text-ds-error/80 transition hover:bg-ds-error/10"
                              >
                                <Trash2 className="h-4 w-4" strokeWidth={2} />
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })}
            </div>
          </div>
        </div>
      </fieldset>

      {lines.some((l) => !!l.fgReservation) ? (
        <div className="rounded-ds-lg bg-ds-elevated/30 p-3 shadow-ds-depth-sm">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand-primary)]">
            FG reservation log
          </p>
          <div className="space-y-1.5 text-xs">
            {lines
              .filter((l) => !!l.fgReservation)
              .map((l, idx) => (
                <div
                  key={`${l.id ?? idx}-${l.fgReservation?.reservationKey ?? idx}`}
                  className="rounded px-2 py-1.5 text-ds-ink-faint bg-ds-elevated/30"
                >
                  <span className="text-ds-ink">{l.cartonName || `Line ${idx + 1}`}</span>
                  {' · '}Reserved {l.fgReservation?.qtyReserved.toLocaleString('en-IN')}{' '}
                  {l.fgReservation?.unit} from {l.fgReservation?.materialCode}
                  {' · '}Use reserved first: {l.useReservedFirst !== false ? 'Yes' : 'No'}
                  {' · '}
                  {l.fgReservation?.reservedAt
                    ? new Date(l.fgReservation.reservedAt).toLocaleString()
                    : '—'}
                </div>
              ))}
          </div>
        </div>
      ) : null}

      <div
        className="fixed bottom-0 left-0 right-0 z-40 bg-background/85 shadow-[0_-8px_32px_rgba(0,0,0,0.55)] backdrop-blur-md"
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
                    className="h-full flex-none bg-[var(--info-bg)] transition-[width] duration-300"
                    style={{
                      width: `${(supplyMaterialCounts.blue / supplyMaterialCounts.total) * 100}%`,
                    }}
                  />
                  <div
                    className="h-full flex-none bg-[var(--success-bg)] transition-[width] duration-300"
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
                  className={`${poMono} text-[1.2rem] font-bold leading-none text-[#2563eb] sm:text-[1.35rem]`}
                >
                  ₹{grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => router.push('/orders/purchase-orders')}
                className="rounded-ds-md bg-ds-card/80 px-3 py-2 text-xs font-medium text-ds-ink hover:bg-ds-elevated/50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="ci-btn-save-industrial rounded-ds-md px-5 py-2 text-xs font-semibold disabled:opacity-50"
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
        updateLineField={updateLineField}
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
