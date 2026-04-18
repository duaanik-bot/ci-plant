'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ListChecks, Star, Truck, X } from 'lucide-react'
import { PROCUREMENT_DEFAULT_SIGNATORY } from '@/lib/procurement-mrp-service'
import type { MaterialReadinessRollup } from '@/lib/procurement-mrp-service'
import { IndustrialModuleShell, industrialTableClassName } from '@/components/industrial/IndustrialModuleShell'
import { IndustrialKpiTile } from '@/components/industrial/IndustrialKpiTile'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { spotlightHighlightText } from '@/lib/spotlight-highlight'
import {
  DEBIT_NOTE_DRAFT_SIGNATURE,
  WEIGHT_VARIANCE_DEBIT_TOLERANCE_PCT,
} from '@/lib/weight-reconciliation'
import {
  STRATEGIC_SOURCING_GOLD,
  STRATEGIC_SOURCING_GOLD_BORDER,
  STRATEGIC_SOURCING_GOLD_SOFT,
} from '@/lib/vendor-reliability-scorecard'
import { SHORT_CLOSE_REASONS, type ShortCloseReason } from '@/lib/vendor-po-short-close'
import { PROCUREMENT_LOGISTICS_AUDIT_ACTOR } from '@/lib/procurement-logistics-hud'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

type MaterialVitals = {
  openMaterialSpendInr: number
  incomingBoardKg7d: number
  criticalShortagePoCount: number
  priceVariancePct: number | null
  monthlyWeightLossInr: number
}

type LeadBuffer = {
  bufferHours: number
  level: 'ok' | 'at_risk' | 'critical'
  badgeLabel: string
  vendorPoId: string
  vendorPoNumber: string
  vendorEtaYmd: string
  productionTargetYmd: string
  primaryCustomerName: string
  supplierId: string
}

type WeightVarianceAgg = {
  displayPercent: number
  absPercent: number
  varianceKg: number
  level: 'slate' | 'amber' | 'red'
}

type LineReconciliationDto = {
  invoiceWeightKg: number
  scaleWeightKg: number
  coreWeightKg: number
  netReceivedKg: number
  varianceKg: number
  variancePercent: number | null
  ratePerKgInr: number | null
  invoiceNumber: string | null
  reconciliationStatus: string
  vendorMaterialPoLineId: string | null
  debitNoteDraftText: string | null
}

type SupplierReliability = {
  grade: 'A' | 'B' | 'C'
  compositeScore: number
  deliveryScore: number
  weightScore: number
}

type ProcurementHud = {
  variant:
    | 'planned'
    | 'ordered'
    | 'received'
    | 'mixed'
    | 'mill_dispatched'
    | 'in_transit'
    | 'in_transit_stale'
    | 'at_gate'
    | 'short_closed'
  label: string
  logisticsStale: boolean
  primaryVendorPoId: string | null
  primaryVendorPoNumber: string | null
  primarySupplierName: string | null
  logistics: {
    transporterName: string | null
    lrNumber: string | null
    vehicleNumber: string | null
    estimatedArrivalAt: string | null
    logisticsStatus: string | null
    logisticsUpdatedAt: string | null
  } | null
  shortClose: {
    isRecord: boolean
    authorityGateMet: boolean
    completionPct: number
    orderedKg: number
    receivedKg: number
    closedByName?: string | null
    closedReason?: string | null
  } | null
}

type Requirement = {
  key: string
  boardType: string
  gsm: number
  grainDirection: string
  sheetSizeLabel: string
  totalSheets: number
  totalWeightKg: number
  totalMetricTons: number
  oldestCalculatedAt: string
  industrialPriority: boolean
  readinessRollup: MaterialReadinessRollup
  procurementHud: ProcurementHud
  leadBuffer: LeadBuffer | null
  weightVariance: WeightVarianceAgg | null
  supplierReliability: SupplierReliability | null
  contributions: {
    poLineItemId: string
    poId: string
    poNumber: string
    customerName: string
    cartonName: string
    quantity: number
    sheets: number
    weightKg: number
    jobCardNumber: number | null
    customerDeliveryYmd: string | null
    vendorRequiredDeliveryYmd: string | null
    materialProcurementStatus: string
  }[]
  suggestedSupplierId: string | null
  suggestedSupplierName: string | null
}

type SupplierOpt = {
  id: string
  name: string
  materialTypes: string[]
  defaultForBoardGrades?: string[]
}

type VendorPoDetail = {
  id: string
  poNumber: string
  status: string
  signatoryName: string
  requiredDeliveryDate: string | null
  remarks: string | null
  dispatchedAt?: string | null
  dispatchActor?: string | null
  supplier: { id: string; name: string; email?: string | null; contactPhone?: string | null }
  lines: {
    id: string
    boardGrade: string
    gsm: number
    grainDirection: string
    totalSheets: number
    totalWeightKg: string
    ratePerKg: string | null
  }[]
}

type PriceIntelRow = {
  ratePerKg: number | null
  poNumber: string
  supplierName: string
  dispatchedAt: string | null
  kg: number
}

function formatRupee(n: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(n)
}

const industrialMono = 'font-[family-name:var(--font-designing-queue),ui-monospace]'

function procurementHudBadgeClass(variant: ProcurementHud['variant']): string {
  switch (variant) {
    case 'mill_dispatched':
      return 'border-slate-500/55 text-slate-200 bg-slate-400/15'
    case 'in_transit':
      return 'border-sky-500/50 text-sky-100 bg-blue-500/20'
    case 'in_transit_stale':
      return 'border-amber-500/60 text-amber-100 bg-blue-500/20 animate-pulse'
    case 'at_gate':
      return 'border-emerald-500/50 text-emerald-100 bg-emerald-500/20'
    case 'short_closed':
      return 'border-slate-600/50 bg-slate-800/50 text-slate-400'
    case 'received':
      return 'border-emerald-600/50 text-emerald-200 bg-emerald-950/35'
    case 'planned':
      return 'border-slate-500/60 text-slate-300 bg-slate-950/60'
    case 'ordered':
      return 'border-sky-500/50 text-sky-200 bg-sky-950/40'
    case 'mixed':
    default:
      return 'border-amber-500/50 text-amber-200 bg-amber-950/35'
  }
}

function varianceBadgeClass(level: WeightVarianceAgg['level']): string {
  if (level === 'slate') return 'border-slate-600/70 text-slate-300 bg-slate-950/50'
  if (level === 'amber') return 'border-amber-500/60 text-amber-100 bg-amber-950/40'
  return 'border-rose-500/65 text-rose-100 bg-rose-950/45'
}

function ReliabilityBadge({ rel }: { rel: SupplierReliability | null }) {
  if (!rel) {
    return (
      <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-zinc-700 bg-zinc-900 px-1 text-[9px] font-black text-zinc-600">
        —
      </span>
    )
  }
  const cls =
    rel.grade === 'A'
      ? 'border-emerald-500/70 bg-emerald-950/45 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.25)]'
      : rel.grade === 'B'
        ? 'border-amber-500/65 bg-amber-950/40 text-amber-100'
        : 'border-rose-500/70 bg-rose-950/40 text-rose-100 animate-pulse'
  const title = `Reliability ${rel.grade} · composite ${rel.compositeScore} (60% OTIF dispatch · 40% weight)`
  return (
    <span
      title={title}
      className={`inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border px-1 text-[10px] font-black tabular-nums ${cls}`}
    >
      {rel.grade}
    </span>
  )
}

type SupplierScorecardDetail = {
  supplierId: string
  supplierName: string
  snapshot: SupplierReliability & {
    otifCount: number
    totalDeliveryOrders: number
    avgAbsVariancePct: number | null
  }
  monthlyDeliveryAccuracy: { monthKey: string; label: string; accuracyPct: number; orders: number }[]
  cumulativeWeightLossKg: number
  avgLeadTimeDays: number | null
}

function leadBufferBadgeClass(level: LeadBuffer['level']): string {
  if (level === 'critical') return 'border-rose-500/70 text-rose-100 bg-rose-950/50 font-bold'
  if (level === 'at_risk') return 'border-amber-500/65 text-amber-100 bg-amber-950/45 font-semibold'
  return 'border-emerald-800/50 text-emerald-200/90 bg-emerald-950/30'
}

function leadBufferRowGlow(lb: LeadBuffer | null): string {
  if (!lb) return ''
  if (lb.level === 'critical') {
    return 'shadow-[0_0_26px_rgba(244,63,94,0.42)] ring-1 ring-rose-500/55 animate-pulse'
  }
  if (lb.level === 'at_risk') {
    return 'shadow-[0_0_20px_rgba(245,158,11,0.28)] ring-1 ring-amber-500/40'
  }
  return ''
}

function daysSinceRequest(iso: string): number {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return (Date.now() - t) / 86_400_000
}

export default function ProcurementWorkbenchPage() {
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [vitals, setVitals] = useState<MaterialVitals | null>(null)
  const [suggestedSupplier, setSuggestedSupplier] = useState<{ id: string; name: string } | null>(null)
  const [suppliers, setSuppliers] = useState<SupplierOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [supplierId, setSupplierId] = useState('')
  const [generating, setGenerating] = useState(false)
  const [draft, setDraft] = useState<VendorPoDetail | null>(null)
  const [draftLoading, setDraftLoading] = useState(false)
  const [lineRates, setLineRates] = useState<Record<string, string>>({})
  const [lastPurchaseBenchmark, setLastPurchaseBenchmark] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [spotlightRow, setSpotlightRow] = useState<Requirement | null>(null)
  const [priceIntel, setPriceIntel] = useState<{ history: PriceIntelRow[]; lastPurchaseRate: number | null } | null>(
    null,
  )
  const [priceIntelLoading, setPriceIntelLoading] = useState(false)
  const [supplierPerf, setSupplierPerf] = useState<{ avgDaysLate: number | null; sampleSize: number } | null>(null)
  const [atRiskVendorPoCount, setAtRiskVendorPoCount] = useState(0)
  const [vendorRiskIndexCount, setVendorRiskIndexCount] = useState(0)
  const [canAuthorizeShortClose, setCanAuthorizeShortClose] = useState(false)
  const [riskFilterHigh, setRiskFilterHigh] = useState(false)
  const [vendorRiskFilterHigh, setVendorRiskFilterHigh] = useState(false)
  const [scorecardDetail, setScorecardDetail] = useState<SupplierScorecardDetail | null>(null)
  const [scorecardLoading, setScorecardLoading] = useState(false)
  const [warningSending, setWarningSending] = useState(false)
  const [lineReconciliations, setLineReconciliations] = useState<Record<string, LineReconciliationDto>>({})
  const [scaleInputs, setScaleInputs] = useState<Record<string, string>>({})
  const [coreInputs, setCoreInputs] = useState<Record<string, string>>({})
  const [receiptSavingId, setReceiptSavingId] = useState<string | null>(null)
  const [debitDraftingId, setDebitDraftingId] = useState<string | null>(null)
  const [logisticsTransporter, setLogisticsTransporter] = useState('')
  const [logisticsLr, setLogisticsLr] = useState('')
  const [logisticsVehicle, setLogisticsVehicle] = useState('')
  const [logisticsEta, setLogisticsEta] = useState('')
  const [logisticsStatusPick, setLogisticsStatusPick] = useState<
    'mill_dispatched' | 'in_transit' | 'at_gate'
  >('mill_dispatched')
  const [logisticsSaving, setLogisticsSaving] = useState(false)
  const [followUpSending, setFollowUpSending] = useState(false)
  const [shortCloseModalOpen, setShortCloseModalOpen] = useState(false)
  const [shortCloseReasonPick, setShortCloseReasonPick] = useState<ShortCloseReason>(
    SHORT_CLOSE_REASONS[0],
  )
  const [shortCloseRemarks, setShortCloseRemarks] = useState('')
  const [shortCloseSubmitting, setShortCloseSubmitting] = useState(false)

  const loadRequirements = useCallback(
    async (qArg: string, riskHighOnly: boolean, vendorRiskHighOnly: boolean) => {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        if (qArg.trim()) params.set('q', qArg.trim())
        if (riskHighOnly) params.set('risk', 'high')
        if (vendorRiskHighOnly) params.set('vendorRisk', 'high')
        const qs = params.toString() ? `?${params.toString()}` : ''
        const res = await fetch(`/api/procurement/material-requirements${qs}`)
        const json = (await res.json()) as {
          requirements?: Requirement[]
          lineReconciliations?: Record<string, LineReconciliationDto>
          suggestedSupplier?: { id: string; name: string } | null
          vitals?: MaterialVitals
          atRiskVendorPoCount?: number
          vendorRiskIndexCount?: number
          canAuthorizeShortClose?: boolean
          factoryTimeZone?: string
          error?: string
        }
        if (!res.ok) throw new Error(json.error || 'Failed to load requirements')
        const list = json.requirements ?? []
        setRequirements(list)
        setLineReconciliations(json.lineReconciliations ?? {})
        setVitals(json.vitals ?? null)
        setAtRiskVendorPoCount(json.atRiskVendorPoCount ?? 0)
        setVendorRiskIndexCount(json.vendorRiskIndexCount ?? 0)
        setCanAuthorizeShortClose(Boolean(json.canAuthorizeShortClose))
        setSuggestedSupplier(json.suggestedSupplier ?? null)
        if (json.suggestedSupplier?.id) {
          setSupplierId((cur) => cur || json.suggestedSupplier!.id)
        }
        return list
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Load failed')
        return null
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (!spotlightRow) setShortCloseModalOpen(false)
  }, [spotlightRow])

  useEffect(() => {
    if (shortCloseModalOpen) {
      setShortCloseRemarks('')
      setShortCloseReasonPick(SHORT_CLOSE_REASONS[0])
    }
  }, [shortCloseModalOpen])

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(searchQ), 320)
    return () => window.clearTimeout(t)
  }, [searchQ])

  useEffect(() => {
    void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)
  }, [debouncedQ, riskFilterHigh, vendorRiskFilterHigh, loadRequirements])

  useEffect(() => {
    const onPri = () => {
      void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)
    }
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [debouncedQ, riskFilterHigh, vendorRiskFilterHigh, loadRequirements])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/procurement/suppliers')
        if (!res.ok) return
        const list = (await res.json()) as SupplierOpt[]
        setSuppliers(Array.isArray(list) ? list : [])
      } catch {
        setSuppliers([])
      }
    })()
  }, [])

  useEffect(() => {
    if (!spotlightRow) {
      setPriceIntel(null)
      setSupplierPerf(null)
      return
    }
    const { boardType, gsm, suggestedSupplierId } = spotlightRow
    setPriceIntel(null)
    setSupplierPerf(null)
    setPriceIntelLoading(true)
    void (async () => {
      try {
        const [piRes, perfRes] = await Promise.all([
          fetch(
            `/api/procurement/board-price-intel?boardGrade=${encodeURIComponent(boardType)}&gsm=${encodeURIComponent(String(gsm))}`,
          ),
          suggestedSupplierId
            ? fetch(`/api/procurement/supplier-performance?supplierId=${encodeURIComponent(suggestedSupplierId)}`)
            : Promise.resolve(null as Response | null),
        ])
        const piJson = (await piRes.json()) as {
          history?: PriceIntelRow[]
          lastPurchaseRate?: number | null
          error?: string
        }
        if (piRes.ok) {
          setPriceIntel({
            history: piJson.history ?? [],
            lastPurchaseRate: piJson.lastPurchaseRate ?? null,
          })
        }
        if (perfRes && perfRes.ok) {
          const p = (await perfRes.json()) as { avgDaysLate: number | null; sampleSize: number }
          setSupplierPerf(p)
        }
      } catch {
        setPriceIntel({ history: [], lastPurchaseRate: null })
      } finally {
        setPriceIntelLoading(false)
      }
    })()
  }, [spotlightRow])

  useEffect(() => {
    const sid = spotlightRow?.suggestedSupplierId
    if (!sid) {
      setScorecardDetail(null)
      setScorecardLoading(false)
      return
    }
    setScorecardLoading(true)
    setScorecardDetail(null)
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(
          `/api/procurement/supplier-scorecard?supplierId=${encodeURIComponent(sid)}`,
        )
        const json = (await res.json()) as SupplierScorecardDetail & { error?: string }
        if (!res.ok || cancelled) {
          if (!cancelled) setScorecardDetail(null)
          return
        }
        if (!cancelled) setScorecardDetail(json)
      } catch {
        if (!cancelled) setScorecardDetail(null)
      } finally {
        if (!cancelled) setScorecardLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [spotlightRow?.suggestedSupplierId])

  useEffect(() => {
    if (!spotlightRow) return
    const l = spotlightRow.procurementHud.logistics
    if (l) {
      setLogisticsTransporter(l.transporterName ?? '')
      setLogisticsLr(l.lrNumber ?? '')
      setLogisticsVehicle(l.vehicleNumber ?? '')
      const st = l.logisticsStatus?.trim().toLowerCase()
      if (st === 'at_gate' || st === 'in_transit' || st === 'mill_dispatched') {
        setLogisticsStatusPick(st)
      } else {
        setLogisticsStatusPick('mill_dispatched')
      }
      if (l.estimatedArrivalAt) {
        const d = new Date(l.estimatedArrivalAt)
        const pad = (n: number) => String(n).padStart(2, '0')
        setLogisticsEta(
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
        )
      } else {
        setLogisticsEta('')
      }
    } else {
      setLogisticsTransporter('')
      setLogisticsLr('')
      setLogisticsVehicle('')
      setLogisticsEta('')
      setLogisticsStatusPick('mill_dispatched')
    }
  }, [spotlightRow?.key])

  useEffect(() => {
    if (!spotlightRow) return
    const nextS: Record<string, string> = {}
    const nextC: Record<string, string> = {}
    for (const c of spotlightRow.contributions) {
      if (c.materialProcurementStatus !== 'received') continue
      const rec = lineReconciliations[c.poLineItemId]
      nextS[c.poLineItemId] = rec ? String(rec.scaleWeightKg) : ''
      nextC[c.poLineItemId] = rec ? String(rec.coreWeightKg) : ''
    }
    setScaleInputs(nextS)
    setCoreInputs(nextC)
  }, [spotlightRow, lineReconciliations])

  const selectableKeys = useMemo(
    () =>
      new Set(
        requirements.filter((r) => r.contributions.some((c) => c.materialProcurementStatus === 'pending')).map((r) => r.key),
      ),
    [requirements],
  )

  const toggleKey = (key: string) => {
    if (!selectableKeys.has(key)) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAll = () => {
    const keys = Array.from(selectableKeys)
    if (keys.length === 0) return
    const allSelected = keys.every((k) => selected.has(k))
    if (allSelected) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(keys))
  }

  const poHoverSummary = useMemo(
    () => (r: Requirement) =>
      r.contributions
        .map((c) => {
          const job =
            c.jobCardNumber != null ? `JC-${c.jobCardNumber}` : `line ${c.poLineItemId.slice(0, 8)}…`
          return `${c.poNumber} · ${job} · ${c.cartonName} (${c.quantity} pcs)`
        })
        .join('\n'),
    [],
  )

  const linkedJobIdsDisplay = useMemo(
    () => (r: Requirement) => {
      const tags = r.contributions.map((c) =>
        c.jobCardNumber != null ? `JC-${c.jobCardNumber}` : c.poLineItemId.slice(0, 8),
      )
      const uniq = Array.from(new Set(tags))
      if (uniq.length <= 5) return uniq.join(', ')
      return `${uniq.slice(0, 4).join(', ')} +${uniq.length - 4}`
    },
    [],
  )

  async function openDraft(id: string) {
    setDraftLoading(true)
    setLastPurchaseBenchmark(null)
    try {
      const res = await fetch(`/api/procurement/vendor-pos/${id}`)
      const json = (await res.json()) as VendorPoDetail & { error?: string }
      if (!res.ok) throw new Error(json.error || 'Failed to load vendor PO')
      setDraft(json)
      const rates: Record<string, string> = {}
      for (const ln of json.lines) {
        rates[ln.id] = ln.ratePerKg != null ? String(ln.ratePerKg) : ''
      }
      setLineRates(rates)
      const first = json.lines[0]
      if (first) {
        const intel = await fetch(
          `/api/procurement/board-price-intel?boardGrade=${encodeURIComponent(first.boardGrade)}&gsm=${encodeURIComponent(String(first.gsm))}`,
        )
        const ij = (await intel.json()) as { lastPurchaseRate?: number | null }
        if (intel.ok && ij.lastPurchaseRate != null && ij.lastPurchaseRate > 0) {
          setLastPurchaseBenchmark(ij.lastPurchaseRate)
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setDraftLoading(false)
    }
  }

  async function generateVendorPo() {
    if (selected.size === 0) {
      toast.message('Select at least one requirement row')
      return
    }
    if (!supplierId) {
      toast.message('Select a supplier')
      return
    }
    setGenerating(true)
    try {
      const res = await fetch('/api/procurement/vendor-pos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirementKeys: Array.from(selected),
          supplierId,
        }),
      })
      const json = (await res.json()) as { id?: string; error?: string }
      if (!res.ok) throw new Error(json.error || 'Could not create draft')
      toast.success('Draft vendor PO created')
      setSelected(new Set())
      await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)
      if (json.id) await openDraft(json.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setGenerating(false)
    }
  }

  async function approveAndDispatch() {
    if (!draft) return
    setConfirming(true)
    try {
      const lineRatesPayload = draft.lines.map((ln) => ({
        lineId: ln.id,
        ratePerKg: lineRates[ln.id] === '' || lineRates[ln.id] == null ? null : Number(lineRates[ln.id]),
      }))
      const res = await fetch(`/api/procurement/vendor-pos/${draft.id}/approve-dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signatoryName: draft.signatoryName || PROCUREMENT_DEFAULT_SIGNATORY,
          lineRates: lineRatesPayload,
        }),
      })
      const json = (await res.json()) as { error?: string; email?: string; whatsapp?: string }
      if (!res.ok) throw new Error(json.error || 'Dispatch failed')
      toast.success(
        `Approved & dispatched. Email: ${json.email ?? '—'} · WhatsApp: ${json.whatsapp ?? '—'}`,
      )
      setDraft(null)
      setLastPurchaseBenchmark(null)
      await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setConfirming(false)
    }
  }

  async function sendDelayWarning() {
    if (!spotlightRow?.leadBuffer) return
    const lb = spotlightRow.leadBuffer
    if (lb.level !== 'at_risk' && lb.level !== 'critical') return
    setWarningSending(true)
    try {
      const res = await fetch('/api/procurement/vendor-delay-warning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorPoId: lb.vendorPoId,
          customerName: lb.primaryCustomerName,
        }),
      })
      const json = (await res.json()) as { error?: string; email?: string; whatsapp?: string }
      if (!res.ok) throw new Error(json.error || 'Failed to send warning')
      toast.success(`Delay warning sent (email: ${json.email ?? '—'}, WhatsApp: ${json.whatsapp ?? '—'})`)
      void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setWarningSending(false)
    }
  }

  async function saveWeightReceipt(poLineItemId: string) {
    const scale = parseFloat(scaleInputs[poLineItemId] ?? '')
    const core = parseFloat(coreInputs[poLineItemId] ?? '')
    if (!Number.isFinite(scale) || scale <= 0) {
      toast.message('Enter a valid scale weight (kg)')
      return
    }
    if (!Number.isFinite(core) || core < 0) {
      toast.message('Enter standard core weight (kg) — use 0 if none')
      return
    }
    setReceiptSavingId(poLineItemId)
    try {
      const res = await fetch('/api/procurement/weight-reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poLineItemId, scaleWeightKg: scale, coreWeightKg: core }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success('Weights saved — variance recalculated')
      await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setReceiptSavingId(null)
    }
  }

  async function draftDebitNoteForLine(poLineItemId: string) {
    setDebitDraftingId(poLineItemId)
    try {
      const res = await fetch('/api/procurement/debit-note-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poLineItemId }),
      })
      const json = (await res.json()) as { error?: string; debitNoteDraftText?: string }
      if (!res.ok) throw new Error(json.error || 'Draft failed')
      toast.success('Debit note drafted — reconciliation pending')
      await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Draft failed')
    } finally {
      setDebitDraftingId(null)
    }
  }

  async function saveLogisticsHud() {
    const id = spotlightRow?.procurementHud.primaryVendorPoId
    if (!id) {
      toast.message('No dispatched vendor PO linked for logistics')
      return
    }
    setLogisticsSaving(true)
    try {
      let status = logisticsStatusPick
      if (status !== 'at_gate' && logisticsLr.trim() && logisticsVehicle.trim()) {
        status = 'in_transit'
      }
      const res = await fetch(`/api/procurement/vendor-pos/${id}/logistics`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transporterName: logisticsTransporter.trim() || null,
          lrNumber: logisticsLr.trim() || null,
          vehicleNumber: logisticsVehicle.trim() || null,
          estimatedArrivalAt: logisticsEta ? new Date(logisticsEta).toISOString() : null,
          logisticsStatus: status,
        }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success(`Logistics committed — timestamped (${PROCUREMENT_LOGISTICS_AUDIT_ACTOR})`)
      const list = await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)
      if (list && spotlightRow) {
        const u = list.find((x) => x.key === spotlightRow.key)
        if (u) setSpotlightRow(u)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setLogisticsSaving(false)
    }
  }

  async function sendLogisticsFollowUp() {
    const hud = spotlightRow?.procurementHud
    if (!hud?.logisticsStale || !hud.primaryVendorPoId) return
    const customerName =
      spotlightRow?.leadBuffer?.primaryCustomerName ??
      spotlightRow?.contributions[0]?.customerName ??
      'Customer'
    setFollowUpSending(true)
    try {
      const res = await fetch('/api/procurement/logistics-intransit-followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorPoId: hud.primaryVendorPoId,
          customerName,
        }),
      })
      const json = (await res.json()) as {
        error?: string
        whatsappSent?: number
        managersEligible?: number
      }
      if (!res.ok) throw new Error(json.error || 'Follow-up failed')
      toast.success(
        `Procurement managers notified (WhatsApp: ${json.whatsappSent ?? 0}/${json.managersEligible ?? 0})`,
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Follow-up failed')
    } finally {
      setFollowUpSending(false)
    }
  }

  async function confirmShortClosePo() {
    const id = spotlightRow?.procurementHud.primaryVendorPoId
    const sc = spotlightRow?.procurementHud.shortClose
    if (!id || !sc?.authorityGateMet || sc.isRecord) return
    const remarks = shortCloseRemarks.trim()
    if (remarks.length < 10) {
      toast.error('Remarks must be at least 10 characters')
      return
    }
    setShortCloseSubmitting(true)
    try {
      const res = await fetch(`/api/procurement/vendor-pos/${id}/short-close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: shortCloseReasonPick, remarks }),
      })
      const json = (await res.json()) as { error?: string; message?: string }
      if (!res.ok) throw new Error(json.error || 'Short-close failed')
      toast.success(json.message ?? 'Vendor PO short-closed')
      setShortCloseModalOpen(false)
      const key = spotlightRow.key
      const list = await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)
      if (list) {
        const u = list.find((x) => x.key === key)
        if (u) setSpotlightRow(u)
        else setSpotlightRow(null)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Short-close failed')
    } finally {
      setShortCloseSubmitting(false)
    }
  }

  const qTrim = debouncedQ.trim()
  const glassKpi =
    'ring-1 ring-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.35)] bg-gradient-to-br from-slate-950/50 to-slate-900/30'

  return (
    <IndustrialModuleShell
      title="Material Readiness Hub"
      subtitle={
        'Supply vitals, board readiness by customer PO, vendor intelligence, and mill→gate logistics (LR, vehicle, ETA). Lead-time buffers use factory IST vs vendor ETA (or in-transit estimated arrival) and production need-by dates. Reliability grades (A/B/C) recomputed on every refresh from dispatched vendor POs and gate weight reconciliations. Deep search matches customer PO #, vendor PO #, vendor name, product/carton, and job IDs.'
      }
      kpiRow={
        <>
          <IndustrialKpiTile
            label="Open material spend"
            value={vitals ? formatRupee(vitals.openMaterialSpendInr) : '—'}
            hint="Draft + confirmed vendor POs (₹)"
            valueClassName="text-amber-200/95"
            shellClassName={glassKpi}
          />
          <IndustrialKpiTile
            label="Incoming tonnage (7d)"
            value={
              vitals
                ? `${(vitals.incomingBoardKg7d / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} t`
                : '—'
            }
            hint="Kg at gate · next 7 days"
            valueClassName="text-sky-200/95"
            shellClassName={glassKpi}
          />
          <IndustrialKpiTile
            label="Critical shortages"
            value={vitals ? vitals.criticalShortagePoCount : '—'}
            hint="Confirmed POs · pending board · no warehouse match"
            valueClassName={vitals && vitals.criticalShortagePoCount > 0 ? 'text-rose-300' : 'text-slate-100'}
            shellClassName={glassKpi}
          />
          <IndustrialKpiTile
            label="Price variance (MoM)"
            value={
              vitals?.priceVariancePct != null
                ? `${vitals.priceVariancePct > 0 ? '+' : ''}${vitals.priceVariancePct}%`
                : '—'
            }
            hint="Avg ₹/kg vs last month"
            valueClassName={
              vitals?.priceVariancePct != null && vitals.priceVariancePct > 0
                ? 'text-rose-300'
                : vitals?.priceVariancePct != null && vitals.priceVariancePct < 0
                  ? 'text-emerald-300'
                  : 'text-slate-100'
            }
            shellClassName={glassKpi}
          />
          <IndustrialKpiTile
            label="Monthly weight loss"
            value={vitals ? formatRupee(vitals.monthlyWeightLossInr ?? 0) : '—'}
            hint="Short-weight ₹ value MTD (gate vs invoice)"
            valueClassName={
              vitals && (vitals.monthlyWeightLossInr ?? 0) > 0 ? 'text-rose-200/95 font-mono' : 'text-slate-100 font-mono'
            }
            shellClassName={glassKpi}
          />
          <IndustrialKpiTile
            label="At-risk orders"
            value={atRiskVendorPoCount}
            hint={'Vendor POs · buffer < 48h (IST)'}
            valueClassName={atRiskVendorPoCount > 0 ? 'text-amber-200/95' : 'text-slate-100'}
            shellClassName={glassKpi}
            onClick={() => setRiskFilterHigh((v) => !v)}
            isActive={riskFilterHigh}
          />
          <IndustrialKpiTile
            label="Vendor risk index"
            value={vendorRiskIndexCount}
            hint="Active rows · suggested supplier grade C"
            valueClassName={vendorRiskIndexCount > 0 ? 'text-orange-300/95' : 'text-slate-100'}
            shellClassName={`${glassKpi} ${
              vendorRiskIndexCount > 0 ? `${STRATEGIC_SOURCING_GOLD_BORDER} ${STRATEGIC_SOURCING_GOLD_SOFT}` : ''
            }`}
            onClick={() => setVendorRiskFilterHigh((v) => !v)}
            isActive={vendorRiskFilterHigh}
          />
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-white/10 bg-slate-950/40 px-3 py-3 backdrop-blur-xl ring-1 ring-white/5">
        <label className="block flex-1 min-w-[200px]">
          <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
            Deep relational search
          </span>
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Customer PO #, vendor name, product/carton, JC…"
            className="mt-1 w-full rounded-md border border-slate-600 bg-black px-3 py-2 text-sm text-white placeholder:text-slate-500"
          />
        </label>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Supplier</label>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="min-w-[14rem] rounded-md border border-slate-600 bg-slate-950 px-2 py-1.5 text-xs text-white"
          >
            <option value="">Select…</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {suggestedSupplier ? (
          <p className="text-[11px] text-slate-500 pb-1">
            Suggested: <span className="text-amber-200/90">{suggestedSupplier.name}</span>
          </p>
        ) : null}
        <button
          type="button"
          disabled={generating || selected.size === 0}
          onClick={() => void generateVendorPo()}
          className="ci-btn-procurement text-xs disabled:opacity-50"
        >
          {generating ? 'Generating…' : 'Generate Vendor PO'}
        </button>
        <button
          type="button"
          onClick={() => void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh)}
          className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-900"
        >
          Refresh
        </button>
        {riskFilterHigh ? (
          <button
            type="button"
            onClick={() => setRiskFilterHigh(false)}
            className="rounded-md border border-amber-500/50 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-950/50"
          >
            Clear lead-time filter
          </button>
        ) : null}
        {vendorRiskFilterHigh ? (
          <button
            type="button"
            onClick={() => setVendorRiskFilterHigh(false)}
            className={`rounded-md border px-3 py-1.5 text-xs hover:opacity-90 ${STRATEGIC_SOURCING_GOLD_BORDER} ${STRATEGIC_SOURCING_GOLD_SOFT} ${STRATEGIC_SOURCING_GOLD}`}
          >
            Clear vendor risk filter
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="text-slate-500 text-sm">Loading readiness grid…</p>
      ) : requirements.length === 0 ? (
        <p className="text-slate-500 text-sm">
          {vendorRiskFilterHigh && riskFilterHigh
            ? 'No rows match both lead-time stress and high vendor risk for this search. Clear one or both filters.'
            : vendorRiskFilterHigh
              ? 'No active rows with grade C suggested suppliers for this search. Clear the vendor risk filter or refresh after new dispatches and reconciliations.'
              : riskFilterHigh
                ? 'No high-risk lead-time rows for this search. Clear the lead-time filter or refresh after updating vendor ETAs.'
                : 'No active material rows for this search. Confirm customer POs and material queue lines (pending through in-transit).'}
        </p>
      ) : (
        <div className={industrialTableClassName()}>
          <table className="w-full text-left text-[10px] leading-tight border-collapse">
            <thead className="bg-slate-950/90 text-slate-400 border-b border-slate-800">
              <tr>
                <th className="px-1.5 py-1.5 w-8">
                  <input
                    type="checkbox"
                    checked={
                      selectableKeys.size > 0 &&
                      Array.from(selectableKeys).every((k) => selected.has(k))
                    }
                    onChange={selectAll}
                    aria-label="Select all pending buckets"
                  />
                </th>
                <th className="px-1.5 py-1.5 w-10">Pri</th>
                <th className="px-1.5 py-1.5">Board / paper</th>
                <th className="px-1.5 py-1.5">Status</th>
                <th className="px-1.5 py-1.5">Age</th>
                <th className="px-1.5 py-1.5 whitespace-nowrap">Risk (IST)</th>
                <th className="px-1.5 py-1.5 whitespace-nowrap">Variance</th>
                <th className="px-1.5 py-1.5 text-right">Tonnage (t)</th>
                <th className="px-1.5 py-1.5">Linked jobs</th>
                <th className="px-1.5 py-1.5">Suggested vendor</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((r, rowIdx) => {
                const pri = r.industrialPriority
                  ? 'ring-2 ring-amber-500/50 shadow-[0_0_22px_rgba(234,88,12,0.22)] bg-amber-950/12'
                  : ''
                const riskGlow = leadBufferRowGlow(r.leadBuffer)
                const days = daysSinceRequest(r.oldestCalculatedAt)
                const ageCritical = r.procurementHud.variant === 'planned' && days * 24 >= 48
                const canSelect = selectableKeys.has(r.key)
                const lb = r.leadBuffer
                const wv = r.weightVariance
                const shortClosedTitle =
                  r.procurementHud.variant === 'short_closed' &&
                  r.procurementHud.shortClose?.isRecord
                    ? `Closed by ${r.procurementHud.shortClose.closedByName?.trim() || '—'} - ${r.procurementHud.shortClose.closedReason?.trim() || '—'}`
                    : undefined
                return (
                  <tr
                    key={r.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSpotlightRow(r)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSpotlightRow(r)
                      }
                    }}
                    className={`border-b border-slate-800/80 text-slate-200 cursor-pointer ${
                      rowIdx % 2 === 0 ? 'bg-black/40' : 'bg-slate-950/30'
                    } ${pri} ${riskGlow}`}
                  >
                    <td className="px-1.5 py-1 align-top" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        disabled={!canSelect}
                        checked={selected.has(r.key)}
                        onChange={() => toggleKey(r.key)}
                        aria-label={`Select ${r.key}`}
                      />
                    </td>
                    <td className="px-1.5 py-1 align-top">
                      <Star
                        className={`h-3.5 w-3.5 ${
                          r.industrialPriority ? 'text-amber-400 fill-amber-400' : 'text-zinc-600'
                        }`}
                        strokeWidth={r.industrialPriority ? 0 : 1.5}
                      />
                    </td>
                    <td className="px-1.5 py-1 align-top">
                      <div className="font-medium text-slate-100">
                        {qTrim ? spotlightHighlightText(r.boardType, qTrim) : r.boardType}
                      </div>
                      <div className="text-slate-500 tabular-nums">
                        {r.gsm} gsm · {r.sheetSizeLabel} · {r.grainDirection}
                      </div>
                      <div className="text-slate-600 tabular-nums">
                        {r.totalSheets.toLocaleString('en-IN')} sheets ·{' '}
                        {r.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 1 })} kg
                      </div>
                    </td>
                    <td className="px-1.5 py-1 align-top">
                      <span
                        title={shortClosedTitle}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold ${procurementHudBadgeClass(r.procurementHud.variant)}`}
                      >
                        {(r.procurementHud.variant === 'in_transit' ||
                          r.procurementHud.variant === 'in_transit_stale') && (
                          <Truck className="h-3 w-3 shrink-0 opacity-90" aria-hidden />
                        )}
                        {r.procurementHud.variant === 'short_closed' ? 'Short-Closed' : r.procurementHud.label}
                      </span>
                    </td>
                    <td className="px-1.5 py-1 align-top whitespace-nowrap">
                      <span
                        className={`tabular-nums text-[11px] font-medium ${
                          ageCritical ? 'text-rose-400 animate-industrial-age-pulse' : 'text-slate-400'
                        }`}
                        title="Days since material requirement calculated"
                      >
                        {days.toFixed(1)}d
                      </span>
                    </td>
                    <td className="px-1.5 py-1 align-top">
                      {lb ? (
                        <span
                          className={`inline-flex rounded-md border px-1.5 py-0.5 text-[9px] font-bold tabular-nums whitespace-nowrap ${leadBufferBadgeClass(lb.level)}`}
                          title={`Vendor ETA ${lb.vendorEtaYmd} · Need by ${lb.productionTargetYmd} · ${lb.vendorPoNumber}`}
                        >
                          {lb.badgeLabel}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-1.5 py-1 align-top">
                      {wv ? (
                        <span
                          className={`inline-flex rounded-md border px-1.5 py-0.5 text-[9px] font-bold font-mono tabular-nums whitespace-nowrap ${varianceBadgeClass(wv.level)} ${
                            wv.level === 'red' ? 'animate-pulse' : ''
                          }`}
                          title={`Δkg ${wv.varianceKg.toFixed(3)} (invoice − net received)`}
                        >
                          {wv.displayPercent >= 0 ? '+' : ''}
                          {wv.displayPercent.toFixed(2)}%
                        </span>
                      ) : (
                        <span className="text-zinc-600 font-mono text-[9px]">—</span>
                      )}
                    </td>
                    <td className="px-1.5 py-1 align-top text-right tabular-nums font-semibold text-amber-200/95">
                      {r.totalMetricTons.toLocaleString('en-IN', { maximumFractionDigits: 4 })}
                    </td>
                    <td
                      className="px-1.5 py-1 align-top text-slate-400 font-mono text-[9px] cursor-help"
                      title={poHoverSummary(r)}
                    >
                      {linkedJobIdsDisplay(r)}
                    </td>
                    <td className="px-1.5 py-1 align-top text-slate-400">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <ReliabilityBadge rel={r.supplierReliability} />
                        <span className="truncate">{r.suggestedSupplierName ?? '—'}</span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <SlideOverPanel
        title="Procurement spotlight"
        isOpen={!!spotlightRow}
        onClose={() => setSpotlightRow(null)}
        widthClass="max-w-md"
        backdropClassName="bg-black/55"
        panelClassName="border-l border-zinc-800 bg-[#000000] shadow-2xl"
      >
        {spotlightRow ? (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs text-slate-300">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Board spec</p>
              <p className="text-sm font-semibold text-slate-100 mt-0.5">
                {spotlightRow.boardType} · {spotlightRow.gsm} gsm
              </p>
              <p className="text-slate-500 mt-0.5">
                {spotlightRow.sheetSizeLabel} · {spotlightRow.grainDirection}
              </p>
            </div>

            {spotlightRow.procurementHud.primaryVendorPoId ? (
              <>
                <div className="rounded-lg border border-zinc-700 bg-zinc-950/55 p-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-wide text-cyan-500/90 font-semibold">
                    Digital waybill
                  </p>
                  <div className="space-y-2 text-[11px]">
                    <div className="flex justify-between gap-2 border-b border-zinc-800/80 pb-2">
                      <span className="text-slate-500">Vendor (mill)</span>
                      <span className="text-slate-200 text-right font-medium">
                        {spotlightRow.procurementHud.primarySupplierName ?? '—'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2 border-b border-zinc-800/80 pb-2">
                      <span className="text-slate-500">Transporter</span>
                      <span className="text-slate-200 text-right">{logisticsTransporter.trim() || '—'}</span>
                    </div>
                    <div className="flex justify-between gap-2 border-b border-zinc-800/80 pb-2">
                      <span className="text-slate-500">LR / Docket</span>
                      <span
                        className={`text-slate-100 text-right tracking-tight ${industrialMono}`}
                      >
                        {logisticsLr.trim() || '—'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2 border-b border-zinc-800/80 pb-2">
                      <span className="text-slate-500">Vehicle</span>
                      <span
                        className={`text-slate-100 text-right font-semibold tracking-wide ${industrialMono}`}
                      >
                        {logisticsVehicle.trim() || '—'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Target customer PO</span>
                      <span className="text-slate-300 text-right font-mono text-[10px]">
                        {Array.from(new Set(spotlightRow.contributions.map((c) => c.poNumber))).join(' · ') ||
                          '—'}
                      </span>
                    </div>
                    <p className="text-[9px] text-zinc-600 pt-1">
                      Vendor PO{' '}
                      <span className={industrialMono}>
                        {spotlightRow.procurementHud.primaryVendorPoNumber ?? '—'}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-sky-500/30 bg-sky-950/10 p-3 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[10px] uppercase tracking-wide text-sky-400/90 font-semibold">
                      Logistics &amp; tracking
                    </p>
                    {spotlightRow.procurementHud.logistics?.logisticsUpdatedAt ? (
                      <span className="text-[9px] text-zinc-500" title="Last logistics commit (server)">
                        Updated{' '}
                        {new Date(
                          spotlightRow.procurementHud.logistics.logisticsUpdatedAt,
                        ).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[10px] text-zinc-500 leading-snug">
                    Saving LR and vehicle promotes the load to{' '}
                    <strong className="text-sky-200">In-Transit</strong> automatically. When in-transit, the
                    lead buffer uses your estimated arrival vs production target. All writes are timestamped (
                    {PROCUREMENT_LOGISTICS_AUDIT_ACTOR}).
                  </p>
                  <label className="block text-[10px] text-slate-500">
                    Transporter
                    <input
                      list="ci-transporter-picks"
                      value={logisticsTransporter}
                      onChange={(e) => setLogisticsTransporter(e.target.value)}
                      className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-slate-100 text-[11px]"
                      placeholder="Carrier name"
                    />
                  </label>
                  <datalist id="ci-transporter-picks">
                    {[
                      'Blue Dart',
                      'Gati',
                      'VRL Logistics',
                      'OM Logistics',
                      'Mahindra Logistics',
                      'Self / Own vehicle',
                    ].map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                  <label className="block text-[10px] text-slate-500">
                    LR number (docket ID)
                    <input
                      value={logisticsLr}
                      onChange={(e) => setLogisticsLr(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-slate-100 text-[11px] ${industrialMono}`}
                    />
                  </label>
                  <label className="block text-[10px] text-slate-500">
                    Vehicle number
                    <input
                      value={logisticsVehicle}
                      onChange={(e) => setLogisticsVehicle(e.target.value.toUpperCase())}
                      className={`mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-slate-100 text-[12px] font-semibold ${industrialMono}`}
                    />
                  </label>
                  <label className="block text-[10px] text-slate-500">
                    Estimated arrival
                    <input
                      type="datetime-local"
                      value={logisticsEta}
                      onChange={(e) => setLogisticsEta(e.target.value)}
                      className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-slate-100 text-[11px]"
                    />
                  </label>
                  <label className="block text-[10px] text-slate-500">
                    Logistics status
                    <select
                      value={logisticsStatusPick}
                      onChange={(e) =>
                        setLogisticsStatusPick(e.target.value as typeof logisticsStatusPick)
                      }
                      className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-slate-100 text-[11px]"
                    >
                      <option value="mill_dispatched">Mill dispatched</option>
                      <option value="in_transit">In-transit</option>
                      <option value="at_gate">At gate</option>
                    </select>
                  </label>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      disabled={logisticsSaving}
                      onClick={(e) => {
                        e.stopPropagation()
                        void saveLogisticsHud()
                      }}
                      className="w-full rounded-lg border border-sky-500/50 bg-sky-950/40 px-3 py-2 text-[11px] font-bold text-sky-100 hover:bg-sky-950/55 disabled:opacity-50"
                    >
                      {logisticsSaving ? 'Saving…' : 'Save logistics (timestamped)'}
                    </button>
                    {spotlightRow.procurementHud.logisticsStale ? (
                      <button
                        type="button"
                        disabled={followUpSending}
                        onClick={(e) => {
                          e.stopPropagation()
                          void sendLogisticsFollowUp()
                        }}
                        className="w-full rounded-lg border border-amber-500/55 bg-amber-950/35 px-3 py-2 text-[11px] font-bold text-amber-100 hover:bg-amber-950/50 disabled:opacity-50"
                      >
                        {followUpSending ? 'Notifying…' : 'Follow-up — notify procurement managers'}
                      </button>
                    ) : null}
                    {canAuthorizeShortClose &&
                    spotlightRow.procurementHud.shortClose &&
                    !spotlightRow.procurementHud.shortClose.isRecord ? (
                      <button
                        type="button"
                        disabled={!spotlightRow.procurementHud.shortClose.authorityGateMet}
                        title={
                          spotlightRow.procurementHud.shortClose.authorityGateMet
                            ? 'Short-close this vendor PO (audit logged)'
                            : 'Short-close requires ≥95% of ordered kg received at gate'
                        }
                        onClick={(e) => {
                          e.stopPropagation()
                          if (!spotlightRow.procurementHud.shortClose?.authorityGateMet) return
                          setShortCloseModalOpen(true)
                        }}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/45 bg-amber-950/25 px-3 py-2 text-[11px] font-semibold text-amber-100 hover:bg-amber-950/40 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <ListChecks className="h-3.5 w-3.5 opacity-90" aria-hidden />
                        Short-Close PO
                      </button>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-[11px] text-zinc-600">
                Logistics HUD unlocks after the vendor PO is{' '}
                <span className="text-slate-400">dispatched</span> from the mill.
              </p>
            )}

            {spotlightRow.leadBuffer ? (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
                  Lead-time buffer (factory IST)
                </p>
                <div
                  className={`rounded-lg border p-2.5 space-y-2 ${
                    spotlightRow.leadBuffer.level === 'critical'
                      ? 'border-rose-500/50 bg-rose-950/25'
                      : spotlightRow.leadBuffer.level === 'at_risk'
                        ? 'border-amber-500/45 bg-amber-950/20'
                        : 'border-zinc-700 bg-zinc-950/40'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold ${leadBufferBadgeClass(spotlightRow.leadBuffer.level)}`}
                    >
                      {spotlightRow.leadBuffer.level === 'critical'
                        ? 'Critical delay'
                        : spotlightRow.leadBuffer.level === 'at_risk'
                          ? 'At risk'
                          : 'On track'}
                    </span>
                    <span className="text-sm font-bold tabular-nums text-slate-100">
                      {spotlightRow.leadBuffer.badgeLabel}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    Vendor ETA{' '}
                    <span className="text-slate-300 font-mono">{spotlightRow.leadBuffer.vendorEtaYmd}</span>
                    {spotlightRow.procurementHud.variant === 'in_transit' ||
                    spotlightRow.procurementHud.variant === 'in_transit_stale' ? (
                      <span className="text-zinc-600"> (from estimated arrival when in-transit)</span>
                    ) : null}
                    {' · '}
                    Production target{' '}
                    <span className="text-slate-300 font-mono">{spotlightRow.leadBuffer.productionTargetYmd}</span>
                    {' · '}
                    <span className="text-slate-400">{spotlightRow.leadBuffer.vendorPoNumber}</span>
                  </p>
                  {(spotlightRow.leadBuffer.level === 'at_risk' ||
                    spotlightRow.leadBuffer.level === 'critical') && (
                    <button
                      type="button"
                      disabled={warningSending}
                      onClick={(e) => {
                        e.stopPropagation()
                        void sendDelayWarning()
                      }}
                      className="w-full rounded-lg border border-rose-500/55 bg-rose-950/35 px-3 py-2 text-[11px] font-bold text-rose-100 hover:bg-rose-950/55 disabled:opacity-50"
                    >
                      {warningSending ? 'Sending…' : 'Generate delay warning'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-zinc-600">
                No linked vendor PO with a gate ETA — lead-time buffer not computed for this bucket.
              </p>
            )}

            {spotlightRow.suggestedSupplierId ? (
              <div
                className={`rounded-lg border p-3 space-y-3 ${STRATEGIC_SOURCING_GOLD_BORDER} ${STRATEGIC_SOURCING_GOLD_SOFT}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className={`text-[10px] uppercase tracking-wide font-semibold ${STRATEGIC_SOURCING_GOLD}`}>
                    Director&apos;s audit · Supplier performance
                  </p>
                  {spotlightRow.supplierReliability ? (
                    <ReliabilityBadge rel={spotlightRow.supplierReliability} />
                  ) : null}
                </div>
                {scorecardLoading ? (
                  <p className="text-[11px] text-slate-500">Loading strategic scorecard…</p>
                ) : scorecardDetail ? (
                  <>
                    <p className="text-[11px] text-slate-400">
                      <span className="text-slate-500">Supplier:</span>{' '}
                      {scorecardDetail.supplierName}
                    </p>
                    <div className="h-36 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={scorecardDetail.monthlyDeliveryAccuracy}
                          margin={{ top: 4, right: 4, left: -18, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                          <XAxis
                            dataKey="label"
                            tick={{ fill: '#a1a1aa', fontSize: 9 }}
                            interval={0}
                            angle={-12}
                            textAnchor="end"
                            height={36}
                          />
                          <YAxis
                            domain={[0, 100]}
                            tick={{ fill: '#a1a1aa', fontSize: 9 }}
                            width={28}
                            tickFormatter={(v) => `${v}%`}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: '#09090b',
                              border: `1px solid rgba(245, 158, 11, 0.35)`,
                              borderRadius: 8,
                              fontSize: 11,
                            }}
                            labelStyle={{ color: '#e4e4e7' }}
                            formatter={(value: number, _n, item) => [
                              `${value}% (${(item?.payload as { orders?: number })?.orders ?? 0} dispatches)`,
                              'OTIF accuracy',
                            ]}
                          />
                          <Bar
                            dataKey="accuracyPct"
                            name="Delivery accuracy"
                            fill="#f59e0b"
                            radius={[3, 3, 0, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="text-[9px] text-zinc-500">
                      Monthly delivery accuracy (last 6 months) · dispatch vs required date
                    </p>
                    <div className="grid grid-cols-1 gap-2 text-[11px]">
                      <div
                        className={`rounded-md border px-2.5 py-2 ${STRATEGIC_SOURCING_GOLD_BORDER} bg-black/40`}
                      >
                        <p className="text-zinc-500 text-[9px] uppercase tracking-wide font-semibold">
                          Total weight loss (cumulative)
                        </p>
                        <p className={`mt-0.5 font-bold tabular-nums ${STRATEGIC_SOURCING_GOLD}`}>
                          {scorecardDetail.cumulativeWeightLossKg.toLocaleString('en-IN', {
                            maximumFractionDigits: 3,
                          })}{' '}
                          KGs
                        </p>
                      </div>
                      <div
                        className={`rounded-md border px-2.5 py-2 ${STRATEGIC_SOURCING_GOLD_BORDER} bg-black/40`}
                      >
                        <p className="text-zinc-500 text-[9px] uppercase tracking-wide font-semibold">
                          Average lead time
                        </p>
                        <p className={`mt-0.5 font-bold tabular-nums ${STRATEGIC_SOURCING_GOLD}`}>
                          {scorecardDetail.avgLeadTimeDays != null
                            ? `${scorecardDetail.avgLeadTimeDays.toLocaleString('en-IN')} days`
                            : '—'}
                          <span className="text-zinc-600 font-normal text-[10px]">
                            {' '}
                            (dispatch → reconciliation)
                          </span>
                        </p>
                      </div>
                    </div>
                    <p className="text-[9px] text-zinc-600 leading-snug">
                      Snapshot: delivery {scorecardDetail.snapshot.deliveryScore} · weight{' '}
                      {scorecardDetail.snapshot.weightScore} · composite{' '}
                      {scorecardDetail.snapshot.compositeScore}{' '}
                      <span className="font-mono">({scorecardDetail.snapshot.otifCount}/
                      {scorecardDetail.snapshot.totalDeliveryOrders} OTIF dispatches)</span>
                    </p>
                  </>
                ) : (
                  <p className="text-[11px] text-zinc-600">Scorecard unavailable for this supplier.</p>
                )}
              </div>
            ) : null}

            {spotlightRow.contributions.some((c) => c.materialProcurementStatus === 'received') ? (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
                  Material receipt (weights)
                </p>
                <p className="text-[10px] text-zinc-600 mb-2 leading-snug">
                  <span className="font-mono">Net kg</span> = scale (actual) − standard core.{' '}
                  <span className="font-mono">Variance</span> = invoice kg − net. Mark the line received on the
                  customer PO before saving weights.
                </p>
                <ul className="space-y-3">
                  {spotlightRow.contributions
                    .filter((c) => c.materialProcurementStatus === 'received')
                    .map((c) => {
                      const rec = lineReconciliations[c.poLineItemId]
                      const scale = scaleInputs[c.poLineItemId] ?? ''
                      const core = coreInputs[c.poLineItemId] ?? ''
                      const scaleN = parseFloat(scale)
                      const coreN = parseFloat(core)
                      const net =
                        Number.isFinite(scaleN) && Number.isFinite(coreN) ? scaleN - coreN : null
                      const inv = rec?.invoiceWeightKg ?? c.weightKg
                      const varKg =
                        inv != null && net != null ? inv - net : null
                      const varPct =
                        inv != null && inv > 0 && varKg != null ? (varKg / inv) * 100 : null
                      const canGenerateDebit =
                        rec &&
                        rec.variancePercent != null &&
                        Math.abs(rec.variancePercent) > WEIGHT_VARIANCE_DEBIT_TOLERANCE_PCT &&
                        rec.varianceKg > 0 &&
                        (rec.ratePerKgInr ?? 0) > 0 &&
                        !rec.debitNoteDraftText
                      return (
                        <li
                          key={c.poLineItemId}
                          className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 space-y-2"
                        >
                          <p className="text-[11px] text-slate-200 font-medium">
                            {c.poNumber} · {c.cartonName}
                          </p>
                          <div className="grid grid-cols-2 gap-2 text-[10px]">
                            <label className="text-slate-500">
                              Scale weight (kg)
                              <input
                                type="number"
                                min={0}
                                step={0.001}
                                value={scale}
                                onChange={(e) =>
                                  setScaleInputs((prev) => ({
                                    ...prev,
                                    [c.poLineItemId]: e.target.value,
                                  }))
                                }
                                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1 font-mono text-slate-100 text-[11px]"
                              />
                            </label>
                            <label className="text-slate-500">
                              Standard core (kg)
                              <input
                                type="number"
                                min={0}
                                step={0.001}
                                value={core}
                                onChange={(e) =>
                                  setCoreInputs((prev) => ({
                                    ...prev,
                                    [c.poLineItemId]: e.target.value,
                                  }))
                                }
                                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1 font-mono text-slate-100 text-[11px]"
                              />
                            </label>
                          </div>
                          <div className="font-mono text-[10px] text-slate-400 space-y-0.5 tabular-nums">
                            <p>
                              Invoice (kg):{' '}
                              <span className="text-slate-200">
                                {inv != null && inv > 0 ? inv.toFixed(3) : '—'}
                              </span>
                              {!rec ? (
                                <span className="text-zinc-600"> (planned · confirm on save)</span>
                              ) : null}
                            </p>
                            <p>
                              Net received (kg):{' '}
                              <span className="text-slate-200">
                                {net != null ? net.toFixed(3) : '—'}
                              </span>
                            </p>
                            <p>
                              Variance (kg / %):{' '}
                              <span
                                className={
                                  varPct != null && Math.abs(varPct) > 1.5
                                    ? 'text-rose-300'
                                    : varPct != null && Math.abs(varPct) >= 0.5
                                      ? 'text-amber-200'
                                      : 'text-slate-200'
                                }
                              >
                                {varKg != null ? `${varKg.toFixed(3)} kg` : '—'}
                                {varPct != null
                                  ? ` · ${varPct >= 0 ? '+' : ''}${varPct.toFixed(2)}%`
                                  : ''}
                              </span>
                            </p>
                          </div>
                          {rec?.reconciliationStatus === 'reconciliation_pending' ? (
                            <p className="text-[10px] font-semibold text-amber-300/90">
                              Reconciliation pending — debit path active
                            </p>
                          ) : null}
                          <button
                            type="button"
                            disabled={receiptSavingId === c.poLineItemId}
                            onClick={(e) => {
                              e.stopPropagation()
                              void saveWeightReceipt(c.poLineItemId)
                            }}
                            className="w-full rounded-md border border-zinc-600 bg-zinc-900 py-1.5 text-[10px] font-semibold text-slate-200 hover:bg-zinc-800 disabled:opacity-50"
                          >
                            {receiptSavingId === c.poLineItemId ? 'Saving…' : 'Save weights & variance'}
                          </button>
                          {canGenerateDebit ? (
                            <button
                              type="button"
                              disabled={debitDraftingId === c.poLineItemId}
                              onClick={(e) => {
                                e.stopPropagation()
                                void draftDebitNoteForLine(c.poLineItemId)
                              }}
                              className="w-full rounded-md border border-rose-500/50 bg-rose-950/30 py-1.5 text-[10px] font-bold text-rose-100 hover:bg-rose-950/45 disabled:opacity-50"
                            >
                              {debitDraftingId === c.poLineItemId
                                ? 'Drafting…'
                                : 'Generate debit note'}
                            </button>
                          ) : null}
                          {rec?.debitNoteDraftText ? (
                            <div>
                              <pre className="whitespace-pre-wrap rounded border border-zinc-800 bg-black p-2 text-[10px] font-mono text-slate-300 leading-relaxed">
                                {rec.debitNoteDraftText}
                              </pre>
                              <p className="text-[9px] text-zinc-500 mt-1 leading-snug">{DEBIT_NOTE_DRAFT_SIGNATURE}</p>
                            </div>
                          ) : null}
                        </li>
                      )
                    })}
                </ul>
              </div>
            ) : null}

            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
                Price history (last purchases)
              </p>
              {priceIntelLoading ? (
                <p className="text-slate-500">Loading…</p>
              ) : priceIntel && priceIntel.history.length > 0 ? (
                <ul className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
                  {priceIntel.history.map((h, i) => (
                    <li key={`${h.poNumber}-${i}`} className="flex justify-between gap-2 text-[11px]">
                      <span className="text-slate-400">
                        {h.dispatchedAt ? new Date(h.dispatchedAt).toLocaleDateString('en-IN') : '—'}
                      </span>
                      <span className="text-slate-200 font-mono">
                        {h.ratePerKg != null ? `₹${h.ratePerKg.toFixed(2)}/kg` : '—'}
                      </span>
                      <span className="text-slate-500 truncate max-w-[120px]" title={h.supplierName}>
                        {h.supplierName}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-slate-500">No dispatched rates for this GSM yet.</p>
              )}
              {priceIntel?.lastPurchaseRate != null && priceIntel.lastPurchaseRate > 0 ? (
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Benchmark last rate:{' '}
                  <span className="text-amber-200/90 font-mono tabular-nums">
                    ₹{priceIntel.lastPurchaseRate.toFixed(2)}/kg
                  </span>
                </p>
              ) : null}
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
                Linked demand (customer POs)
              </p>
              <ul className="max-h-48 overflow-y-auto space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
                {spotlightRow.contributions.map((c) => (
                  <li key={c.poLineItemId} className="text-[11px] leading-snug border-b border-zinc-800/60 pb-1.5 last:border-0">
                    <span className="font-mono text-amber-200/80">{c.poNumber}</span>
                    <span className="text-zinc-600"> · </span>
                    {qTrim ? spotlightHighlightText(c.cartonName, qTrim) : c.cartonName}
                    <span className="text-zinc-500 block mt-0.5">
                      {c.customerName} · {c.materialProcurementStatus.replace(/_/g, ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
                Vendor performance
              </p>
              {spotlightRow.suggestedSupplierName ? (
                <p className="text-[11px] text-slate-400 mb-1">{spotlightRow.suggestedSupplierName}</p>
              ) : null}
              {supplierPerf && supplierPerf.sampleSize > 0 ? (
                <p className="text-[11px] text-slate-200">
                  Avg. days late (dispatch vs required):{' '}
                  <span className="font-semibold tabular-nums text-amber-200/90">
                    {supplierPerf.avgDaysLate?.toFixed(1) ?? '—'}
                  </span>
                  <span className="text-slate-500"> · n={supplierPerf.sampleSize}</span>
                </p>
              ) : (
                <p className="text-slate-500 text-[11px]">No benchmark dispatches for this supplier yet.</p>
              )}
            </div>
          </div>
        ) : null}
      </SlideOverPanel>

      {draft || draftLoading ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Vendor PO draft"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-600 bg-slate-950 p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-2 mb-3">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  {draft?.dispatchedAt ? 'Vendor PO (dispatched)' : 'Vendor PO draft'}
                </h2>
                {draft ? (
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {draft.poNumber} · {draft.supplier.name} · {draft.status}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => {
                  setDraft(null)
                  setLastPurchaseBenchmark(null)
                }}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {draftLoading || !draft ? (
              <p className="text-slate-500 text-xs">Loading…</p>
            ) : (
              <div className="space-y-3 text-xs">
                {draft.dispatchedAt ? (
                  <p className="rounded-md border border-sky-800/60 bg-sky-950/35 px-2 py-1.5 text-[11px] text-sky-100/95 leading-snug">
                    Dispatched{' '}
                    {new Date(draft.dispatchedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}
                    {draft.dispatchActor ? ` · ${draft.dispatchActor}` : ''}. PDF (email) and WhatsApp were sent; audit
                    trail in <code className="text-sky-200/80">communication_logs</code>.
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-slate-500">Required delivery</label>
                    <p className="text-slate-200">
                      {draft.requiredDeliveryDate
                        ? String(draft.requiredDeliveryDate).slice(0, 10)
                        : '— (set customer delivery on PO)'}
                    </p>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500">Signatory</label>
                    <input
                      value={draft.signatoryName}
                      onChange={(e) => setDraft({ ...draft, signatoryName: e.target.value })}
                      disabled={!!draft.dispatchedAt}
                      className="mt-0.5 w-full rounded border border-slate-600 bg-slate-900 px-2 py-1 text-white disabled:opacity-50"
                    />
                  </div>
                </div>
                {lastPurchaseBenchmark != null && lastPurchaseBenchmark > 0 ? (
                  <p className="text-[10px] text-slate-500">
                    Last purchase benchmark:{' '}
                    <span className="text-amber-200/90 font-mono">₹{lastPurchaseBenchmark.toFixed(2)}/kg</span>
                    {' — '}rates &gt;5% above highlight in rose.
                  </p>
                ) : null}
                <ul className="space-y-2 border border-slate-800 rounded-md p-2">
                  {draft.lines.map((ln) => {
                    const raw = lineRates[ln.id] ?? ''
                    const num = raw === '' ? NaN : Number(raw)
                    const hot =
                      lastPurchaseBenchmark != null &&
                      lastPurchaseBenchmark > 0 &&
                      Number.isFinite(num) &&
                      num > lastPurchaseBenchmark * 1.05
                    return (
                      <li key={ln.id} className="border-b border-slate-800/80 pb-2 last:border-0 last:pb-0">
                        <p className="font-medium text-slate-200">
                          {ln.boardGrade} · {ln.gsm} GSM · {ln.grainDirection}
                        </p>
                        <p className="text-slate-500">
                          Sheets {ln.totalSheets.toLocaleString('en-IN')} · Weight{' '}
                          {Number(ln.totalWeightKg).toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg
                        </p>
                        <label
                          className={`mt-1 flex items-center gap-2 text-[11px] ${hot ? 'text-rose-300' : 'text-slate-400'}`}
                        >
                          Rate / kg (₹)
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={lineRates[ln.id] ?? ''}
                            onChange={(e) =>
                              setLineRates((prev) => ({ ...prev, [ln.id]: e.target.value }))
                            }
                            disabled={!!draft.dispatchedAt}
                            className={`w-28 rounded border px-1.5 py-0.5 text-white disabled:opacity-50 ${
                              hot
                                ? 'border-rose-500/70 bg-rose-950/40 ring-1 ring-rose-500/30'
                                : 'border-slate-600 bg-slate-900'
                            }`}
                          />
                        </label>
                      </li>
                    )
                  })}
                </ul>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(null)
                      setLastPurchaseBenchmark(null)
                    }}
                    className="rounded-md border border-slate-600 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    disabled={
                      confirming || !!draft.dispatchedAt || draft.status === 'cancelled'
                    }
                    onClick={() => void approveAndDispatch()}
                    className="ci-btn-procurement text-xs disabled:opacity-40"
                  >
                    {confirming ? 'Dispatching…' : 'Approve & dispatch'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {shortCloseModalOpen &&
      canAuthorizeShortClose &&
      spotlightRow?.procurementHud.shortClose &&
      !spotlightRow.procurementHud.shortClose.isRecord &&
      spotlightRow.procurementHud.shortClose.authorityGateMet ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Short-close vendor PO"
        >
          <div
            className={`w-full max-w-md rounded-xl border bg-black p-4 shadow-2xl ring-1 ring-amber-500/20 ${STRATEGIC_SOURCING_GOLD_BORDER}`}
          >
            <h3 className={`text-[13px] font-bold tracking-tight ${STRATEGIC_SOURCING_GOLD}`}>
              Short-close vendor PO
            </h3>
            <p className="text-[10px] text-zinc-500 mt-1.5 leading-snug">
              Authority: <span className="text-amber-200/90">≥95%</span> received vs ordered. Sets status to{' '}
              <span className="text-slate-300">Closed</span>, flags short-close, and writes a full audit trail (
              reason + remarks).
            </p>
            <div
              className={`mt-3 space-y-1.5 rounded-lg border border-zinc-900 ${STRATEGIC_SOURCING_GOLD_SOFT} p-2.5 text-[10px]`}
            >
              <div className="flex justify-between gap-2 text-zinc-500">
                <span>Ordered (kg)</span>
                <span className={`text-slate-100 tabular-nums ${industrialMono}`}>
                  {spotlightRow.procurementHud.shortClose.orderedKg.toLocaleString('en-IN', {
                    maximumFractionDigits: 3,
                  })}
                </span>
              </div>
              <div className="flex justify-between gap-2 text-zinc-500">
                <span>Received (kg)</span>
                <span className={`text-slate-100 tabular-nums ${industrialMono}`}>
                  {spotlightRow.procurementHud.shortClose.receivedKg.toLocaleString('en-IN', {
                    maximumFractionDigits: 3,
                  })}
                </span>
              </div>
              <div className="flex justify-between gap-2 text-amber-100/95 font-semibold border-t border-zinc-800/80 pt-1.5">
                <span>Balance / completion</span>
                <span className={`tabular-nums ${industrialMono}`}>
                  {(
                    spotlightRow.procurementHud.shortClose.orderedKg -
                    spotlightRow.procurementHud.shortClose.receivedKg
                  ).toLocaleString('en-IN', { maximumFractionDigits: 3 })}{' '}
                  kg · {spotlightRow.procurementHud.shortClose.completionPct.toFixed(2)}%
                </span>
              </div>
            </div>
            <label className="mt-3 block text-[9px] text-zinc-500 uppercase tracking-wide font-bold">
              Reason
              <select
                value={shortCloseReasonPick}
                onChange={(e) => setShortCloseReasonPick(e.target.value as ShortCloseReason)}
                className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-slate-200 text-[11px] normal-case font-medium"
              >
                {SHORT_CLOSE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-2 block text-[9px] text-zinc-500 uppercase tracking-wide font-bold">
              Remarks <span className="text-amber-600/90">(required, min 10)</span>
              <textarea
                value={shortCloseRemarks}
                onChange={(e) => setShortCloseRemarks(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-md border border-zinc-800 bg-black px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-zinc-700"
                placeholder="Document context for audit (e.g. variance detail, director instruction)…"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShortCloseModalOpen(false)}
                className="rounded-md border border-zinc-800 bg-black px-3 py-1.5 text-[11px] text-slate-400 hover:border-zinc-700 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={shortCloseSubmitting || shortCloseRemarks.trim().length < 10}
                onClick={() => void confirmShortClosePo()}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-amber-500/55 bg-amber-950/40 px-3 py-1.5 text-[11px] font-bold text-amber-100 hover:bg-amber-950/55 disabled:opacity-45"
              >
                <ListChecks className="h-3.5 w-3.5" aria-hidden />
                {shortCloseSubmitting ? 'Closing…' : 'Confirm short-close'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </IndustrialModuleShell>
  )
}
