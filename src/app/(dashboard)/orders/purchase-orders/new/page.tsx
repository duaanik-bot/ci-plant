'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  COATING_TYPES,
  EMBOSSING_TYPES,
  FOIL_TYPES,
  PAPER_TYPES,
  BOARD_GRADES,
} from '@/lib/constants'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import {
  mapApiRowToPoCarton,
  usePoRecentCartons,
  type PoCartonCatalogItem,
} from '@/lib/po-carton-autocomplete'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { parseCartonSizeToDims } from '@/lib/die-hub-dimensions'
import { PastingStyle } from '@prisma/client'
import { PoNewLineItemDrawer } from '@/components/po/PoNewLineItemDrawer'
import { PoLinePastingStyleCell } from '@/components/po/PoLinePastingStyleCell'
import { DeliveryDateInput } from '@/components/po/DeliveryDateInput'
import { updateProductMasterStyle } from '@/lib/update-product-master-style'
import { computeSuggestedDelivery } from '@/lib/po-delivery-schedule'
import type { PoToolingSignal } from '@/lib/po-tooling-signal'
import { Copy, Star, Trash2 } from 'lucide-react'

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

/** PO tooling preflight + bulk sync — audit actor for master updates from this form. */
const PO_FORM_TOOLING_AUDIT_ACTOR = 'Anik Dua'

type LineToolingRowMeta = {
  signal: PoToolingSignal
  tooltip: string
}

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
  /** LOCK_BOTTOM | BSO — required on every line; prefilled from Product Master when linked. */
  pastingStyle: string
  /** Visual audit: Product Master has no canonical pastingStyle (null). */
  masterPastingStyleMissing: boolean
  /** Last applied from Product Master — dimmed until user edits that field. */
  ghostFromMaster: { size: boolean; gsm: boolean; pasting: boolean; rate: boolean }
  /** Board/paper procurement; live after PO save. */
  materialProcurementStatus?: string
}

type CartonLookupFieldProps = {
  line: Line
  customerId: string
  /** Subset of products for browse (empty query); full list is not loaded. */
  browseCatalog: CartonOption[]
  browseLoading: boolean
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
  pastingStyle: '',
  masterPastingStyleMissing: false,
  ghostFromMaster: { size: false, gsm: false, pasting: false, rate: false },
  materialProcurementStatus: 'not_calculated',
})

function hasLineInput(line: Line): boolean {
  return Object.entries(line).some(([key, value]) => {
    if (key === 'ghostFromMaster') return false
    if (key === 'backPrint') return value !== 'No'
    if (key === 'wastagePct') return value !== '10'
    if (key === 'gstPct') return value !== '5'
    if (key === 'toolingUnlinked') return value === true
    if (key === 'masterPastingStyleMissing') return value === true
    if (key === 'materialProcurementStatus') return false
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
    pastingStyle: '',
    masterPastingStyleMissing: false,
    ghostFromMaster: { size: false, gsm: false, pasting: false, rate: false },
    materialProcurementStatus: 'not_calculated',
  }
}

function lineAmount(rate: number, chargeableQty: number, gstPct: number): { beforeGst: number; gst: number } {
  const beforeGst = rate * chargeableQty
  const gst = beforeGst * (gstPct / 100)
  return { beforeGst, gst }
}

/** Product / die master → PO line: only BSO or Lock Bottom (default). */
function poPastingStyleFromMaster(c: CartonOption): PastingStyle {
  if (c.pastingStyle === PastingStyle.BSO) return PastingStyle.BSO
  return PastingStyle.LOCK_BOTTOM
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

function poCartonOptionFromMasterCreateResponse(
  created: CartonOption & {
    finishedLength?: number
    finishedWidth?: number
    finishedHeight?: number
    specialInstructions?: string | null
    backPrint?: string | null
    dyeId?: string | null
  },
  fallback: {
    boardGrade?: string
    gsm?: string
    rate?: string
    gstPct?: string
    paperType?: string
    coatingType?: string
    embossingLeafing?: string
    foilType?: string
  },
): CartonOption {
  const cartonSizeStr =
    created.finishedLength != null && created.finishedWidth != null && created.finishedHeight != null
      ? `${created.finishedLength}×${created.finishedWidth}×${created.finishedHeight}`
      : ''
  return {
    id: created.id,
    cartonName: created.cartonName,
    customerId: created.customerId,
    cartonSize: cartonSizeStr,
    boardGrade: (created.boardGrade ?? fallback.boardGrade) || null,
    gsm: created.gsm ?? (fallback.gsm ? Number(fallback.gsm) : null),
    paperType: (created.paperType ?? fallback.paperType) || null,
    rate: created.rate ?? (fallback.rate ? Number(fallback.rate) : null),
    gstPct: created.gstPct ?? Number(fallback.gstPct || '5'),
    coatingType: (created.coatingType ?? fallback.coatingType) || null,
    embossingLeafing: (created.embossingLeafing ?? fallback.embossingLeafing) || null,
    foilType: (created.foilType ?? fallback.foilType) || null,
    artworkCode: created.artworkCode ?? null,
    backPrint: created.backPrint ?? 'No',
    dyeId: created.dyeId ?? null,
    dieMasterId: (created as { dieMasterId?: string | null }).dieMasterId ?? null,
    pastingStyle: created.pastingStyle ?? null,
    masterDieType: null,
    toolingDimsLabel: cartonSizeStr || null,
    toolingUnlinked: !(created as { dieMasterId?: string | null }).dieMasterId,
    specialInstructions: created.specialInstructions ?? null,
  }
}

function CartonLookupField({
  line,
  customerId,
  browseCatalog,
  browseLoading,
  error,
  onLineChange,
  onSelect,
  onCreate,
}: CartonLookupFieldProps) {
  const { lastUsed, pushRecent } = usePoRecentCartons(customerId || undefined)
  const cartonQuery = line.cartonName
  const trimmedQuery = cartonQuery.trim()

  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchHits, setSearchHits] = useState<CartonOption[]>([])
  const [searchFetchLoading, setSearchFetchLoading] = useState(false)

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(trimmedQuery), 320)
    return () => window.clearTimeout(t)
  }, [trimmedQuery])

  useEffect(() => {
    if (!customerId || !debouncedQuery) {
      setSearchHits([])
      setSearchFetchLoading(false)
      return
    }
    let cancelled = false
    setSearchFetchLoading(true)
    void (async () => {
      try {
        const res = await fetch(
          `/api/cartons?customerId=${encodeURIComponent(customerId)}&q=${encodeURIComponent(debouncedQuery)}&limit=150`,
        )
        const data = (await res.json()) as Record<string, unknown>[]
        if (cancelled) return
        if (!Array.isArray(data)) {
          setSearchHits([])
          return
        }
        setSearchHits(data.map(mapApiRowToPoCarton))
      } catch {
        if (!cancelled) setSearchHits([])
      } finally {
        if (!cancelled) setSearchFetchLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [customerId, debouncedQuery])

  const debounceSynced = trimmedQuery === debouncedQuery
  const searchOptions =
    trimmedQuery.length > 0 && debounceSynced && !searchFetchLoading ? searchHits : []
  const searchLoading = trimmedQuery.length > 0 && (!debounceSynced || searchFetchLoading)

  useEffect(() => {
    if (line.cartonId || !line.cartonName.trim()) return
    const normalizedName = line.cartonName.trim().toLowerCase()
    const useSearch = trimmedQuery.length > 0
    const loading = useSearch ? searchLoading : browseLoading
    if (loading) return
    const pool = useSearch ? searchHits : browseCatalog
    const exactMatches = pool.filter((c) => c.cartonName.trim().toLowerCase() === normalizedName)
    if (exactMatches.length !== 1) return
    const [match] = exactMatches
    pushRecent(match)
    onSelect(match)
  }, [
    line.cartonId,
    line.cartonName,
    browseCatalog,
    browseLoading,
    searchHits,
    searchLoading,
    trimmedQuery,
    onSelect,
    pushRecent,
  ])

  return (
    <div className="min-w-[180px]">
      <MasterSearchSelect
        label="Carton name"
        hideLabel
        query={cartonQuery}
        onQueryChange={(value) => onLineChange(resetAutofillFields(line, value))}
        loading={searchLoading}
        options={searchOptions}
        lastUsed={lastUsed}
        browseOptions={browseCatalog}
        browseOptionsLabel="Products for this customer"
        browseLoading={browseLoading}
        browseEmptyMessage={
          customerId && !browseLoading && browseCatalog.length === 0
            ? 'No products for this customer yet.'
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
        emptyMessage={customerId ? 'No matching master for this customer.' : 'Select customer first.'}
        recentLabel="Recent cartons"
        loadingMessage="Searching cartons..."
        emptyActionLabel={customerId && trimmedQuery ? '[+ Create as New Product]' : undefined}
        onEmptyAction={() => {
          const suggestedName = trimmedQuery
          if (suggestedName) onCreate(suggestedName)
        }}
        inputClassName="min-w-[260px] px-2 py-1 text-xs whitespace-normal"
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
  /** Writes `PurchaseOrder.isPriority` for Planning and Plate/CTP queue ordering. */
  const [isPriority, setIsPriority] = useState(false)
  const [deliveryRequiredBy, setDeliveryRequiredBy] = useState('')
  /** User edited delivery date manually — stop overwriting with auto-suggest until reset. */
  const [deliveryByCustom, setDeliveryByCustom] = useState(false)
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

  /** Inline row quick-create (Size / GSM / Pasting) when master search has no hit. */
  const [inlineCartonLineIndex, setInlineCartonLineIndex] = useState<number | null>(null)
  const [inlineCartonForm, setInlineCartonForm] = useState({
    sizeL: '',
    sizeW: '',
    sizeH: '',
    gsm: '',
    pastingStyle: PastingStyle.LOCK_BOTTOM as PastingStyle,
  })
  const [inlineCartonSaving, setInlineCartonSaving] = useState(false)

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [customerCartons, setCustomerCartons] = useState<CartonOption[]>([])
  const [customerCartonsLoading, setCustomerCartonsLoading] = useState(false)
  const [masterPastePopoverLine, setMasterPastePopoverLine] = useState<number | null>(null)
  const [masterPasteSavingLine, setMasterPasteSavingLine] = useState<number | null>(null)
  /** Highlights Size + Pasting cells once after Product Master apply. */
  const [masterPulseLine, setMasterPulseLine] = useState<number | null>(null)

  const [lineToolingByIdx, setLineToolingByIdx] = useState<Record<number, LineToolingRowMeta>>({})
  /** One-shot row highlight after hub status sync (e.g. new line). */
  const [toolingRowPulse, setToolingRowPulse] = useState<number | null>(null)
  const toolingPulseAfterFetchIdx = useRef<number | null>(null)
  /** Open line master-detail (full specs in drawer, not the bulk tooling footer). */
  const [detailLineIdx, setDetailLineIdx] = useState<number | null>(null)
  /** Keyboard “current row” when the line drawer is closed (for ↑↓, Enter, Alt+D, etc.). */
  const [kbRowIndex, setKbRowIndex] = useState(0)

  const toolingPayloadKey = useMemo(
    () =>
      JSON.stringify(
        lines.map((ln, i) => [
          i,
          ln.cartonId,
          ln.dieMasterId,
          ln.toolingUnlinked,
          ln.cartonName,
          ln.quantity,
        ]),
      ),
    [lines],
  )

  const isEditableKeyTarget = (t: EventTarget | null) => {
    if (!t || !(t instanceof HTMLElement)) return false
    if (t.isContentEditable) return true
    const name = t.tagName
    if (name === 'INPUT' || name === 'TEXTAREA' || name === 'SELECT') return true
    return Boolean(t.closest('[contenteditable="true"]'))
  }

  useEffect(() => {
    setKbRowIndex((i) => Math.max(0, Math.min(i, Math.max(0, lines.length - 1))))
  }, [lines.length])

  useEffect(() => {
    let cancelled = false
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch('/api/purchase-orders/tooling-line-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lines: lines.map((ln, key) => ({
                key,
                cartonName: ln.cartonName,
                quantity: ln.quantity,
                cartonId: ln.cartonId,
                dieMasterId: ln.dieMasterId,
                toolingUnlinked: ln.toolingUnlinked,
              })),
            }),
          })
          const json = (await res.json().catch(() => ({}))) as {
            results?: { key: number; signal: PoToolingSignal; tooltip: string }[]
          }
          if (cancelled || !res.ok || !Array.isArray(json.results)) return
          const next: Record<number, LineToolingRowMeta> = {}
          for (const r of json.results) {
            next[r.key] = { signal: r.signal, tooltip: r.tooltip }
          }
          setLineToolingByIdx(next)
          const pulseIdx = toolingPulseAfterFetchIdx.current
          toolingPulseAfterFetchIdx.current = null
          if (pulseIdx != null && json.results.some((r) => r.key === pulseIdx)) {
            setToolingRowPulse(pulseIdx)
            window.setTimeout(() => {
              setToolingRowPulse((cur) => (cur === pulseIdx ? null : cur))
            }, 650)
          }
        } catch {
          if (!cancelled) setLineToolingByIdx({})
        }
      })()
    }, 320)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [toolingPayloadKey])

  useEffect(() => {
    if (!customerId) {
      setCustomerCartons([])
      setCustomerCartonsLoading(false)
      setInlineCartonLineIndex(null)
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

  const deliverySchedule = useMemo(() => computeSuggestedDelivery(lines), [lines])

  const deliveryAutoHint = useMemo(() => {
    if (!deliverySchedule) return null
    if (deliverySchedule.kind === 'repeat') {
      return 'Auto-suggest: repeat product — today + 7 calendar days (you can change the date).'
    }
    return 'Auto-suggest: new tooling — today + 12 calendar days (you can change the date).'
  }, [deliverySchedule])

  useEffect(() => {
    if (deliveryByCustom) return
    if (deliverySchedule) setDeliveryRequiredBy(deliverySchedule.ymd)
    else setDeliveryRequiredBy('')
  }, [deliverySchedule, deliveryByCustom])

  const customerSearch = useAutoPopulate<Customer>({
    storageKey: 'po-customer',
    debounceMs: 150,
    minQueryLength: 2,
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
    setDeliveryByCustom(false)
    void loadCustomerDefaults(c.id)
    setFieldErrors((prev) => {
      const next = { ...prev }
      delete next.customerId
      return next
    })
    if (switchingCustomer && lines.some(hasLineInput)) {
      setLines([defaultLine()])
      setInlineCartonLineIndex(null)
      toast.info('Line items were reset for the newly selected customer.')
    }
  }

  const applyCartonToLine = (idx: number, c: CartonOption) => {
    const decorations = deriveCartonDecorations(c)
    const raw = (c.toolingDimsLabel || c.cartonSize || '').trim()
    const sizeForLine = raw.replace(/x/gi, '×')
    const autoPaste = poPastingStyleFromMaster(c)
    const masterPasteMissing = Boolean(c.id) && c.pastingStyle == null
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
      pastingStyle: autoPaste,
      masterPastingStyleMissing: masterPasteMissing,
      ghostFromMaster: {
        size: true,
        gsm: true,
        pasting: !masterPasteMissing,
        rate: c.rate != null,
      },
    })
    setMasterPulseLine(idx)
    window.setTimeout(() => {
      setMasterPulseLine((cur) => (cur === idx ? null : cur))
    }, 520)
    setFieldErrors((prev) => {
      const next = { ...prev }
      delete next.lines
      return next
    })
  }

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
            : ln,
        ),
      )
      setCustomerCartons((prev) =>
        prev.map((c) => (c.id === cartonId ? { ...c, pastingStyle: style } : c)),
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

  const addLine = () => {
    setLines((prev) => {
      toolingPulseAfterFetchIdx.current = prev.length
      const next = [...prev, defaultLine()]
      setKbRowIndex(next.length - 1)
      return next
    })
  }

  const removeLine = (idx: number) => {
    setInlineCartonLineIndex((openIdx) => {
      if (openIdx === idx) return null
      if (openIdx != null && openIdx > idx) return openIdx - 1
      return openIdx
    })
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
    setMasterPulseLine((p) => {
      if (p === idx) return null
      if (p != null && p > idx) return p - 1
      return p
    })
    setToolingRowPulse((p) => {
      if (p === idx) return null
      if (p != null && p > idx) return p - 1
      return p
    })
    setLines((prev) => prev.filter((_, i) => i !== idx))
  }

  const duplicateLine = (idx: number) => {
    toolingPulseAfterFetchIdx.current = idx + 1
    setLines((prev) => {
      const ln = prev[idx]
      if (!ln) return prev
      const copy: Line = {
        ...ln,
        ghostFromMaster: { ...ln.ghostFromMaster },
      }
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)]
    })
    setInlineCartonLineIndex((open) => {
      if (open === null) return null
      return open > idx ? open + 1 : open
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
    setKbRowIndex(idx + 1)
  }

  const kbdRef = useRef({
    addLine,
    duplicateLine,
    removeLine,
    detailLineIdx: null as number | null,
    kbRowIndex: 0,
    lineCount: 0,
  })
  kbdRef.current = { addLine, duplicateLine, removeLine, detailLineIdx, kbRowIndex, lineCount: lines.length }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        const form = document.getElementById('form-new-po')
        if (form && 'requestSubmit' in form) (form as HTMLFormElement).requestSubmit()
        return
      }
      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        kbdRef.current.addLine()
        return
      }
      if (e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        const { detailLineIdx: di, kbRowIndex: kb } = kbdRef.current
        kbdRef.current.duplicateLine(di ?? kb)
        return
      }
      if (e.altKey && e.key === 'Delete') {
        e.preventDefault()
        const { detailLineIdx: di, kbRowIndex: kb, lineCount } = kbdRef.current
        if (lineCount > 1) kbdRef.current.removeLine(di ?? kb)
        return
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      if (!t || !(t instanceof HTMLElement)) return false
      if (t.isContentEditable) return true
      const name = t.tagName
      if (name === 'INPUT' || name === 'TEXTAREA' || name === 'SELECT') return true
      return Boolean(t.closest('[contenteditable="true"]'))
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey && e.key === 's') || (e.ctrlKey && e.key === 's') || (e.ctrlKey && e.key === 'S')) return
      if (e.altKey) return
      if (kbdRef.current.detailLineIdx !== null) return
      if (isTyping(e.target)) return
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setKbRowIndex((i) => Math.max(0, i - 1))
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        setKbRowIndex((i) => Math.min(Math.max(0, kbdRef.current.lineCount - 1), i + 1))
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setKbRowIndex((i) => Math.max(0, i - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        setDetailLineIdx(kbdRef.current.kbRowIndex)
        return
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

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
    validLines.forEach((l) => {
      const i = lines.findIndex((row) => row === l)
      if (i < 0) return
      if (l.rate === '' || Number(l.rate) < 0) err[`line${i}_rate`] = 'Rate required'
      if (l.pastingStyle !== 'LOCK_BOTTOM' && l.pastingStyle !== 'BSO') {
        err[`line${i}_pasting`] = 'Select Lock Bottom or BSO'
      }
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
          isPriority,
          ...(customPoNumber.trim() ? { poNumber: customPoNumber.trim() } : {}),
          remarks: combinedRemarks || undefined,
          deliveryRequiredBy: deliveryRequiredBy.trim() || null,
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
                pastingStyle: l.pastingStyle as PastingStyle,
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
      const created = data as CartonOption & {
        finishedLength?: number
        finishedWidth?: number
        finishedHeight?: number
        pastingStyle?: PastingStyle | null
        specialInstructions?: string | null
      }
      const formatted = poCartonOptionFromMasterCreateResponse(created, qcCarton)
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

  const submitInlineCreateCarton = async (lineIndex: number) => {
    if (!customerId) {
      toast.error('Select a customer first')
      return
    }
    const line = lines[lineIndex]
    if (!line?.cartonName.trim()) {
      toast.error('Enter a carton name first')
      return
    }
    const l = Number(inlineCartonForm.sizeL)
    const w = Number(inlineCartonForm.sizeW)
    const h = Number(inlineCartonForm.sizeH)
    const gsm = Number(inlineCartonForm.gsm)
    if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
      toast.error('Enter valid length, width, and height (mm).')
      return
    }
    if (!Number.isFinite(gsm) || gsm < 150 || gsm > 600) {
      toast.error('GSM must be between 150 and 600.')
      return
    }
    if (
      inlineCartonForm.pastingStyle !== PastingStyle.LOCK_BOTTOM &&
      inlineCartonForm.pastingStyle !== PastingStyle.BSO
    ) {
      toast.error('Select Lock Bottom or BSO.')
      return
    }
    setInlineCartonSaving(true)
    try {
      const body: Record<string, unknown> = {
        cartonName: line.cartonName.trim(),
        customerId,
        gsm: Math.round(gsm),
        finishedLength: l,
        finishedWidth: w,
        finishedHeight: h,
        pastingStyle: inlineCartonForm.pastingStyle,
        gstPct: 5,
      }
      const res = await fetch('/api/masters/cartons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data?.error ?? 'Failed to create product')
        return
      }
      const created = data as CartonOption & {
        finishedLength?: number
        finishedWidth?: number
        finishedHeight?: number
        pastingStyle?: PastingStyle | null
        specialInstructions?: string | null
      }
      const formatted = poCartonOptionFromMasterCreateResponse(created, {})
      applyCartonToLine(lineIndex, formatted)
      setInlineCartonLineIndex(null)
      setInlineCartonForm({
        sizeL: '',
        sizeW: '',
        sizeH: '',
        gsm: '',
        pastingStyle: PastingStyle.LOCK_BOTTOM,
      })
      setCustomerCartons((prev) => {
        if (prev.some((p) => p.id === formatted.id)) return prev
        return [...prev, formatted].sort((a, b) => a.cartonName.localeCompare(b.cartonName))
      })
      toast.success('Product master created and line updated.')
    } catch {
      toast.error('Failed to create product')
    } finally {
      setInlineCartonSaving(false)
    }
  }

  const inputBase =
    'w-full px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600 text-xs placeholder:text-slate-500'
  const inputCls = `${inputBase} text-foreground`
  const inputClsGhost = `${inputBase} text-slate-400`
  const inputErr = 'border-red-500'
  const lineCellPad = 'px-4 py-2'
  const poMono = 'po-mono-metric'

  return (
    <form
      id="form-new-po"
      onSubmit={handleSubmit}
      className="p-4 max-w-[1600px] mx-auto space-y-4 pb-32"
    >
      <div className="sticky top-0 z-40 -mx-4 mb-1 border-b border-slate-800/90 bg-slate-950/95 px-4 py-2.5 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-bold text-amber-400">New Purchase Order</h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-slate-600 bg-slate-800/80 px-2.5 py-1 text-xs font-medium text-slate-300">
              Draft
            </span>
            <button
              type="button"
              onClick={() => router.push('/orders/purchase-orders')}
              className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
            >
              Back
            </button>
            <button type="submit" disabled={saving} className="ci-btn-save-industrial px-4 py-2 text-sm">
              {saving ? 'Saving…' : 'Save PO'}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm space-y-3">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">Transaction / header</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1">
            <MasterSearchSelect
              label="Supplier (customer)"
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
                [c.gstNumber ? `Code: ${c.gstNumber}` : null, c.contactName, c.contactPhone]
                  .filter(Boolean)
                  .join(' · ')
              }
              error={fieldErrors.customerId}
              placeholder="Type to search (name, GST, or contact)…"
              emptyMessage="No customer found in master."
              recentLabel="Recent customers"
              loadingMessage="Searching customers…"
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
              dropdownFooter={
                <button
                  type="button"
                  onClick={() => {
                    setQcCustomer((prev) => ({
                      ...prev,
                      name: customerSearch.query.trim() || prev.name,
                    }))
                    setQcCustomerOpen(true)
                  }}
                  className="w-full px-3 py-2.5 text-left text-xs font-medium text-amber-400 hover:bg-slate-800/90"
                >
                  + New Customer
                </button>
              }
            />
            {selectedCustomer ? (
              <p className="mt-1 text-[11px] text-slate-500">
                {[selectedCustomer.contactName, selectedCustomer.contactPhone].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </div>
          <div>
            <label className="block text-slate-400 mb-1">PO number</label>
            <p className="px-2 py-1.5 text-sm text-slate-200">
              {customPoNumber.trim() || <span className="text-slate-500">Auto on save (CI-PO-YYYY-####)</span>}
            </p>
            <p className="text-[10px] text-slate-600">Optional number below overrides auto-sequence</p>
          </div>
          <div>
            <label className="block text-slate-400 mb-1">PO date *</label>
            <input
              type="date"
              value={poDate}
              onChange={(e) => setPoDate(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-slate-400 mb-1">
              Custom PO number <span className="text-slate-500">(optional)</span>
            </label>
            <div className="flex items-stretch gap-2">
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
                className={`min-w-0 flex-1 px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${fieldErrors.poNumber ? 'border-red-500' : 'border-slate-600'}`}
                placeholder="Override auto number"
              />
              <button
                type="button"
                onClick={() => setIsPriority((p) => !p)}
                title={isPriority ? 'High priority (Planning / CTP)' : 'Mark high priority'}
                aria-pressed={isPriority}
                aria-label={
                  isPriority ? 'PO is high priority' : 'Mark PO as high priority for Planning and CTP'
                }
                className="shrink-0 flex items-center justify-center w-10 rounded-lg border border-slate-600 bg-slate-800/80 hover:bg-slate-800"
              >
                <Star
                  className={`h-5 w-5 ${isPriority ? 'fill-amber-400 text-amber-400' : 'text-slate-500'}`}
                  strokeWidth={1.5}
                  aria-hidden
                />
              </button>
            </div>
            {fieldErrors.poNumber ? <p className="mt-1 text-xs text-red-400">{fieldErrors.poNumber}</p> : null}
          </div>
          <DeliveryDateInput
            value={deliveryRequiredBy}
            onValueChange={setDeliveryRequiredBy}
            onUserOverride={() => setDeliveryByCustom(true)}
            showCustomBadge={deliveryByCustom}
            autoHint={deliveryByCustom ? null : deliveryAutoHint}
            suggestedYmd={deliverySchedule?.ymd ?? null}
            onUseAutoSuggestion={() => {
              setDeliveryByCustom(false)
              if (deliverySchedule) setDeliveryRequiredBy(deliverySchedule.ymd)
            }}
          />
          <div>
            <label className="block text-slate-400 mb-1">Payment terms</label>
            <input
              type="text"
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
              placeholder="e.g. 30 days"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
          <div className="md:col-span-2">
            <label className="block text-slate-400 mb-1">Remarks</label>
            <input
              type="text"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
            />
          </div>
          <div className="text-slate-500 text-xs pb-2 leading-snug">
            Keys: arrows + Enter (row) · Esc (close) · Alt+N / D / Delete · Ctrl+S save · Full line details in drawer.
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs space-y-3">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-slate-200 font-semibold text-sm">Line items (master → detail)</h2>
          <button
            type="button"
            onClick={addLine}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-foreground text-xs"
          >
            + Add line
          </button>
        </div>
        {fieldErrors.lines && <p className="text-red-400 text-xs">{fieldErrors.lines}</p>}

        <div className="min-h-[240px] max-h-[min(calc(100vh-18rem),640px)] overflow-y-auto rounded-md border border-slate-800/90">
          <table className="w-full table-fixed border-collapse text-left">
            <thead className="sticky top-0 z-30 bg-slate-800/95 text-slate-300 shadow-[inset_0_-1px_0_0_rgb(51_65_85)]">
              <tr>
                <th
                  className={`${lineCellPad} w-[36%] text-left text-[11px] font-semibold sticky left-0 z-40 border-r border-slate-800/90 bg-slate-800/95 shadow-[2px_0_6px_rgba(0,0,0,0.25)]`}
                >
                  Carton
                </th>
                <th className={`${lineCellPad} w-[10%] text-left text-[11px] font-semibold ${poMono}`}>Size</th>
                <th className={`${lineCellPad} w-[8%] text-center text-[11px] font-semibold ${poMono}`}>Qty *</th>
                <th className={`${lineCellPad} w-[14%] text-left text-[11px] font-semibold`}>Pasting</th>
                <th className={`${lineCellPad} w-[14%] text-right text-[11px] font-semibold ${poMono}`}>Rate</th>
                <th className={`${lineCellPad} w-[12%] text-right text-[11px] font-semibold ${poMono}`}>Amount</th>
                <th className={`${lineCellPad} w-[6%] text-right text-[11px] font-normal text-slate-500`} aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {lines.map((ln, idx) => {
                const qty = Number(ln.quantity) || 0
                const rate = Number(ln.rate) || 0
                const gstPct = Number(ln.gstPct) || 0
                const { beforeGst } = lineAmount(rate, qty, gstPct)
                const amount = beforeGst
                const tMeta = lineToolingByIdx[idx]
                const tSig = tMeta?.signal ?? 'red'
                const rowStripe = idx % 2 === 0 ? 'bg-slate-900' : 'bg-slate-800/50'
                const stickBg = idx % 2 === 0 ? 'bg-slate-900' : 'bg-slate-800/50'
                let health: 'ok' | 'sync' | 'block' = 'ok'
                if (ln.masterPastingStyleMissing) health = 'sync'
                if (tSig === 'red') health = 'block'
                if (tSig === 'yellow' && health === 'ok') health = 'sync'
                const rowRing =
                  health === 'block'
                    ? 'ring-1 ring-rose-500/35 ring-inset'
                    : health === 'sync'
                      ? 'ring-1 ring-amber-500/30 ring-inset'
                      : tSig === 'green'
                        ? 'ring-1 ring-emerald-500/20 ring-inset'
                        : ''
                return (
                  <tr
                    key={idx}
                    onMouseEnter={() => setKbRowIndex(idx)}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('input, select, button, a, [data-line-stop]')) return
                      setKbRowIndex(idx)
                      setDetailLineIdx(idx)
                    }}
                    title="Click or Enter — line details & costing (Tab in drawer for fields)"
                    className={`group min-h-[56px] cursor-pointer border-b border-slate-800/80 transition-colors ${rowStripe} ${
                      toolingRowPulse === idx ? 'po-tooling-row-sync-pulse' : ''
                    } ${rowRing} ${
                      detailLineIdx === null && kbRowIndex === idx
                        ? 'ring-1 ring-amber-400/45 ring-inset'
                        : ''
                    }`}
                  >
                    <td
                      className={`${lineCellPad} align-top ${stickBg} sticky left-0 z-20 max-w-0 border-r border-slate-800/80 shadow-[2px_0_6px_rgba(0,0,0,0.2)]`}
                    >
                      <div data-line-stop className="min-w-0" onClick={(e) => e.stopPropagation()}>
                        <CartonLookupField
                          line={ln}
                          customerId={customerId}
                          browseCatalog={customerCartons}
                          browseLoading={customerCartonsLoading}
                          error={!ln.cartonName && fieldErrors.lines ? 'Carton name is required' : undefined}
                          onLineChange={(patch) => updateLine(idx, patch)}
                          onSelect={(carton) => applyCartonToLine(idx, carton)}
                          onCreate={(suggestedName) => {
                            setInlineCartonLineIndex(idx)
                            setInlineCartonForm({
                              sizeL: '',
                              sizeW: '',
                              sizeH: '',
                              gsm: '',
                              pastingStyle: PastingStyle.LOCK_BOTTOM,
                            })
                            setLines((prev) => {
                              const cur = prev[idx]
                              if (!cur) return prev
                              const next = [...prev]
                              next[idx] = resetAutofillFields(cur, suggestedName)
                              return next
                            })
                          }}
                        />
                        {inlineCartonLineIndex === idx ? (
                          <div className="mt-2 rounded-md border border-amber-700/60 bg-slate-950/90 p-2 space-y-2 text-[10px]">
                            <div className="font-semibold text-amber-400">New product — save to master</div>
                            <div className="grid grid-cols-3 gap-1.5">
                              <div>
                                <span className="text-slate-500">L</span>
                                <input
                                  type="number"
                                  step={0.01}
                                  value={inlineCartonForm.sizeL}
                                  onChange={(e) => setInlineCartonForm((p) => ({ ...p, sizeL: e.target.value }))}
                                  className={inputCls}
                                  placeholder="mm"
                                />
                              </div>
                              <div>
                                <span className="text-slate-500">W</span>
                                <input
                                  type="number"
                                  step={0.01}
                                  value={inlineCartonForm.sizeW}
                                  onChange={(e) => setInlineCartonForm((p) => ({ ...p, sizeW: e.target.value }))}
                                  className={inputCls}
                                  placeholder="mm"
                                />
                              </div>
                              <div>
                                <span className="text-slate-500">H</span>
                                <input
                                  type="number"
                                  step={0.01}
                                  value={inlineCartonForm.sizeH}
                                  onChange={(e) => setInlineCartonForm((p) => ({ ...p, sizeH: e.target.value }))}
                                  className={inputCls}
                                  placeholder="mm"
                                />
                              </div>
                            </div>
                            <div>
                              <span className="text-slate-500">GSM</span>
                              <input
                                type="number"
                                value={inlineCartonForm.gsm}
                                onChange={(e) => setInlineCartonForm((p) => ({ ...p, gsm: e.target.value }))}
                                className={inputCls}
                              />
                            </div>
                            <div>
                              <span className="text-slate-500">Pasting</span>
                              <select
                                value={inlineCartonForm.pastingStyle}
                                onChange={(e) =>
                                  setInlineCartonForm((p) => ({
                                    ...p,
                                    pastingStyle: e.target.value as PastingStyle,
                                  }))
                                }
                                className={inputCls}
                              >
                                <option value={PastingStyle.LOCK_BOTTOM}>Lock Bottom</option>
                                <option value={PastingStyle.BSO}>BSO</option>
                              </select>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={inlineCartonSaving}
                                onClick={() => void submitInlineCreateCarton(idx)}
                                className="ci-btn-save-industrial px-2 py-1 text-[10px] disabled:opacity-50"
                              >
                                {inlineCartonSaving ? 'Saving…' : 'Save to master & apply'}
                              </button>
                              <button
                                type="button"
                                disabled={inlineCartonSaving}
                                onClick={() => {
                                  setInlineCartonLineIndex(null)
                                  setActiveCartonLineIndex(idx)
                                  setQcCarton((p) => ({ ...p, cartonName: ln.cartonName.trim() }))
                                  setQcCartonOpen(true)
                                }}
                                className="text-slate-500 underline"
                              >
                                Full form
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td
                      className={`${lineCellPad} ${masterPulseLine === idx ? 'po-master-field-pulse' : ''} align-top`}
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
                          className={`w-full min-w-0 max-w-full truncate ${ln.ghostFromMaster.size ? inputClsGhost : inputCls} ${poMono}`}
                          title={ln.cartonSize}
                          placeholder="L×W×H"
                        />
                      </div>
                    </td>
                    <td className={`${lineCellPad} text-center align-top`} data-line-stop onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        min={1}
                        value={ln.quantity}
                        onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                        className={`inline-block w-14 text-center ${inputCls} ${poMono}`}
                      />
                    </td>
                    <td className={`${lineCellPad} align-top`} data-line-stop onClick={(e) => e.stopPropagation()}>
                      <div className="data-skip-po-enter-chain max-w-full">
                        <PoLinePastingStyleCell
                          lineIndex={idx}
                          cartonId={ln.cartonId}
                          pastingStyle={ln.pastingStyle}
                          masterPastingStyleMissing={ln.masterPastingStyleMissing}
                          ghostFromMaster={ln.ghostFromMaster.pasting}
                          pasteErr={fieldErrors[`line${idx}_pasting`]}
                          inputCls={`w-full min-w-0 text-[10px] ${inputCls}`}
                          inputErr={inputErr}
                          savingToMaster={masterPasteSavingLine === idx}
                          popoverOpenForLine={masterPastePopoverLine}
                          setPopoverOpenForLine={setMasterPastePopoverLine}
                          onPastingSelectChange={(value) =>
                            updateLine(idx, {
                              pastingStyle: value,
                              ghostFromMaster: { ...ln.ghostFromMaster, pasting: false },
                            })
                          }
                          onSaveToMaster={(style) => void saveProductMasterPasting(idx, ln.cartonId, style)}
                        />
                      </div>
                    </td>
                    <td
                      className={`${lineCellPad} text-right align-top`}
                      data-line-stop
                      onClick={(e) => e.stopPropagation()}
                      title={
                        ln.ghostFromMaster.rate
                          ? 'From Product Master — edit to override'
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
                        className={`inline-block w-full min-w-0 max-w-[6.5rem] text-right text-[10px] ${
                          ln.ghostFromMaster.rate ? inputClsGhost : inputCls
                        } ${poMono}`}
                      />
                    </td>
                    <td
                      className={`${lineCellPad} text-right align-top ${poMono} text-slate-200`}
                      title={Number.isFinite(qty) && Number.isFinite(rate) ? `Qty × rate (ex-GST) before tax` : ''}
                    >
                      {amount.toFixed(2)}
                    </td>
                    <td
                      className={`${lineCellPad} text-right align-middle`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="inline-flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          title="Duplicate"
                          onClick={() => duplicateLine(idx)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-700/80 hover:text-amber-300"
                        >
                          <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                        </button>
                        {lines.length > 1 ? (
                          <button
                            type="button"
                            title="Remove"
                            onClick={() => removeLine(idx)}
                            className="rounded p-1 text-red-400/80 hover:bg-red-950/50"
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

      <div
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-700/50 bg-slate-950/90 backdrop-blur-md supports-[backdrop-filter]:bg-slate-950/75"
        aria-live="polite"
        aria-label="Purchase order financial summary"
      >
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[11px] sm:text-xs">
          <span className="font-semibold uppercase tracking-wider text-slate-500">Live summary</span>
          <div className="flex flex-wrap items-baseline justify-end gap-x-6 gap-y-1 text-slate-400">
            <span>
              Total qty <span className={`${poMono} text-foreground`}>{totalQty}</span>
            </span>
            <span>
              Subtotal{' '}
              <span className={`${poMono} text-foreground`}>
                ₹ {subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            </span>
            <span>
              GST{' '}
              <span className={`${poMono} text-foreground`}>
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

      <PoNewLineItemDrawer
        isOpen={detailLineIdx != null}
        onClose={() => setDetailLineIdx(null)}
        lineIndex={detailLineIdx ?? 0}
        line={detailLineIdx != null ? (lines[detailLineIdx] ?? null) : null}
        updateLine={updateLine}
        fieldErrors={fieldErrors}
        inputBase={inputBase}
        inputCls={inputCls}
        inputClsGhost={inputClsGhost}
        inputErr={inputErr}
        poMono={poMono}
        masterPasteSavingLine={masterPasteSavingLine}
        masterPastePopoverLine={masterPastePopoverLine}
        setMasterPastePopoverLine={setMasterPastePopoverLine}
        onSavePastingToMaster={(i, id, s) => void saveProductMasterPasting(i, id, s)}
      />

      <SlideOverPanel title="Quick Create Customer" isOpen={qcCustomerOpen} onClose={() => setQcCustomerOpen(false)}>
        <form onSubmit={submitQuickCreateCustomer} className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Name<span className="text-red-400">*</span></label>
            <input
              type="text"
              value={qcCustomer.name}
              onChange={(e) => setQcCustomer((prev) => ({ ...prev, name: e.target.value }))}
              className={`w-full px-3 py-2 rounded bg-slate-800 border ${qcErrors.name ? 'border-red-500' : 'border-slate-600'} text-foreground`}
            />
            {qcErrors.name && <p className="text-xs text-red-400 mt-1">{qcErrors.name}</p>}
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">GST</label>
            <input type="text" value={qcCustomer.gstNumber} onChange={(e) => setQcCustomer((prev) => ({ ...prev, gstNumber: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Contact / Phone / Email / Address</label>
            <input type="text" value={qcCustomer.contactName} onChange={(e) => setQcCustomer((prev) => ({ ...prev, contactName: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground mb-1" placeholder="Contact" />
            <input type="text" value={qcCustomer.contactPhone} onChange={(e) => setQcCustomer((prev) => ({ ...prev, contactPhone: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground mb-1" placeholder="Phone" />
            <input type="email" value={qcCustomer.email} onChange={(e) => setQcCustomer((prev) => ({ ...prev, email: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground mb-1" placeholder="Email" />
            <textarea rows={2} value={qcCustomer.address} onChange={(e) => setQcCustomer((prev) => ({ ...prev, address: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground" placeholder="Address" />
          </div>
          <div className="flex items-center gap-2">
            <input id="qc-artwork" type="checkbox" checked={qcCustomer.requiresArtworkApproval} onChange={(e) => setQcCustomer((prev) => ({ ...prev, requiresArtworkApproval: e.target.checked }))} className="h-4 w-4 rounded border-slate-500 bg-slate-800" />
            <label htmlFor="qc-artwork" className="text-xs text-slate-300">Requires Artwork Approval</label>
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={qcSaving} className="ci-btn-save-industrial px-5 py-2">Save Customer</button>
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
              className={`w-full px-3 py-2 rounded bg-slate-800 border ${qcCartonErrors.cartonName ? 'border-red-500' : 'border-slate-600'} text-foreground`}
            />
            {qcCartonErrors.cartonName && <p className="text-xs text-red-400 mt-1">{qcCartonErrors.cartonName}</p>}
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Artwork Code (AW)</label>
            <input
              type="text"
              value={qcCarton.artworkCode}
              onChange={(e) => setQcCarton((prev) => ({ ...prev, artworkCode: e.target.value.toUpperCase() }))}
              className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground font-mono"
              placeholder="e.g. AW-12345"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">L</label>
              <input type="number" step={0.01} value={qcCarton.sizeL} onChange={(e) => setQcCarton((prev) => ({ ...prev, sizeL: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">W</label>
              <input type="number" step={0.01} value={qcCarton.sizeW} onChange={(e) => setQcCarton((prev) => ({ ...prev, sizeW: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">H</label>
              <input type="number" step={0.01} value={qcCarton.sizeH} onChange={(e) => setQcCarton((prev) => ({ ...prev, sizeH: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Rate</label>
              <input type="number" step={0.01} value={qcCarton.rate} onChange={(e) => setQcCarton((prev) => ({ ...prev, rate: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">GST%</label>
              <input type="number" min={0} max={28} value={qcCarton.gstPct} onChange={(e) => setQcCarton((prev) => ({ ...prev, gstPct: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Board grade</label>
            <PackagingEnumCombobox
              aria-label="Board grade"
              options={BOARD_GRADES}
              value={qcCarton.boardGrade || null}
              onChange={(v) => setQcCarton((prev) => ({ ...prev, boardGrade: v ?? '' }))}
              controlClassName="border-slate-600 bg-slate-800 hover:bg-slate-800/90 focus-within:ring-slate-500/30"
              inputClassName="text-foreground placeholder:text-slate-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">GSM</label>
              <input type="number" value={qcCarton.gsm} onChange={(e) => setQcCarton((prev) => ({ ...prev, gsm: e.target.value }))} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Paper</label>
              <PackagingEnumCombobox
                aria-label="Paper / board"
                options={PAPER_TYPES}
                value={qcCarton.paperType || null}
                onChange={(v) => setQcCarton((prev) => ({ ...prev, paperType: v ?? '' }))}
                controlClassName="border-slate-600 bg-slate-800 hover:bg-slate-800/90 focus-within:ring-slate-500/30"
                inputClassName="text-foreground placeholder:text-slate-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Coating / Emboss / Foil</label>
            <div className="mb-1">
              <PackagingEnumCombobox
                aria-label="Coating"
                options={COATING_TYPES}
                value={qcCarton.coatingType || null}
                onChange={(v) => setQcCarton((prev) => ({ ...prev, coatingType: v ?? '' }))}
                controlClassName="border-slate-600 bg-slate-800 hover:bg-slate-800/90 focus-within:ring-slate-500/30"
                inputClassName="text-foreground placeholder:text-slate-500"
              />
            </div>
            <div className="mb-1">
              <PackagingEnumCombobox
                aria-label="Embossing"
                options={EMBOSSING_TYPES}
                value={qcCarton.embossingLeafing || null}
                onChange={(v) => setQcCarton((prev) => ({ ...prev, embossingLeafing: v ?? '' }))}
                controlClassName="border-slate-600 bg-slate-800 hover:bg-slate-800/90 focus-within:ring-slate-500/30"
                inputClassName="text-foreground placeholder:text-slate-500"
              />
            </div>
            <PackagingEnumCombobox
              aria-label="Foil"
              options={FOIL_TYPES}
              value={qcCarton.foilType || null}
              onChange={(v) => setQcCarton((prev) => ({ ...prev, foilType: v ?? '' }))}
              controlClassName="border-slate-600 bg-slate-800 hover:bg-slate-800/90 focus-within:ring-slate-500/30"
              inputClassName="text-foreground placeholder:text-slate-500"
            />
          </div>
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={qcCartonSaving} className="ci-btn-save-industrial px-5 py-2">Save Carton</button>
          </div>
        </form>
      </SlideOverPanel>
    </form>
  )
}
