'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { toast } from 'sonner'
import { ClipboardList, IndianRupee, ListChecks, Star, Truck, X } from 'lucide-react'
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
import { GRN_REJECTION_REASONS } from '@/lib/grn-rejection-reasons'
import { priceVariancePct as computePriceVariancePct } from '@/lib/procurement-price-benchmark'
import {
  computeLandedRatePerKg,
  freightPctOfBasicRate,
  isHighLogisticsCostVsBasic,
} from '@/lib/total-landed-cost'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
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
  qcPendingTrucksCount: number
  qualityRecoveriesMonthInr: number
  procurementLeakageMtdInr: number
  pendingPayables30dInr: number
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
  drivenByReplacementEta?: boolean
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
  shortageAwaitingReplacement: boolean
}

type CashFlowTerms = {
  paymentTermsDays: number
  termsBand: 'advance' | 'near_cash' | 'credit'
  badgeLabel: string
  latestReceiptYmd: string | null
  projectedPaymentYmd: string | null
  accruedPayableInr: number | null
  primarySupplierName: string | null
  isProvisional: boolean
  alternativeBetterTerms: { supplierName: string; extraDays: number } | null
}

type LandedCostSnapshot = {
  vendorMaterialLineId: string | null
  vendorPoId: string | null
  basicRatePerKg: number | null
  landedRatePerKg: number | null
  totalWeightKg: number
  freightTotalInr: number
  unloadingChargesInr: number
  insuranceMiscInr: number
  freightPctOfBasic: number | null
}

type ReorderRadar = {
  boardGsmKey: string
  physicalSheets: number
  allocatedSheets: number
  netAvailable: number
  minimumThreshold: number
  maximumBuffer: number
  stockStatus: 'OK' | 'Low_Stock_Alert'
  safetyStatus: 'healthy' | 'low' | 'stockout'
  recommendedReorderSheets: number
  isProcurementRisk: boolean
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
  reorderRadar: ReorderRadar
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
  cashFlowTerms: CashFlowTerms
  landedCost: LandedCostSnapshot
}

function SafetyStatusCell({ radar }: { radar: ReorderRadar }) {
  if (radar.safetyStatus === 'stockout') {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[9px] tabular-nums text-rose-300">
        <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse shrink-0" title="Stock out" />
        OUT
      </span>
    )
  }
  if (radar.safetyStatus === 'low') {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[9px] tabular-nums text-ds-warning">
        <span className="h-2 w-2 rounded-full bg-ds-warning animate-pulse shrink-0" title="Below safety band" />
        LOW
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[9px] tabular-nums text-emerald-300/95">
      <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" title="Healthy buffer" />
      OK
    </span>
  )
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

type Benchmark30dDto = {
  ratePerKg: number
  supplierName: string
  vendorPoNumber: string
}

type TrendMonthDto = {
  monthKey: string
  avgRate: number
  high: number
  low: number
  lastPaid: number
}

type PriceIntelBundle = {
  history: PriceIntelRow[]
  lastPurchaseRate: number | null
  benchmark30d: Benchmark30dDto | null
  trend6m: TrendMonthDto[]
  trendTooltip: { high: number | null; low: number | null; lastPaid: number | null }
}

function emptyPriceIntelBundle(): PriceIntelBundle {
  return {
    history: [],
    lastPurchaseRate: null,
    benchmark30d: null,
    trend6m: [],
    trendTooltip: { high: null, low: null, lastPaid: null },
  }
}

const PRICE_BENCHMARK_WARN_THRESHOLD_PCT = 2.0

function PriceTrendSparkline({
  data,
  tooltip,
}: {
  data: TrendMonthDto[]
  tooltip: PriceIntelBundle['trendTooltip']
}) {
  if (!data.length) {
    return <span className="text-[9px] text-neutral-600 tabular-nums">No 6m trend</span>
  }
  const chartData = data.map((d) => ({ ...d, shortMonth: d.monthKey.slice(5) }))
  return (
    <div className="w-[128px] h-10 shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 2, right: 2, left: 0, bottom: 0 }}>
          <Tooltip
            cursor={{ stroke: '#f59e0b', strokeOpacity: 0.35 }}
            content={() => (
              <div className="rounded border border-ds-line/50 bg-background px-2 py-1.5 text-[9px] text-ds-ink shadow-xl space-y-0.5">
                <div className="font-mono tabular-nums">
                  High:{' '}
                  {tooltip.high != null ? `₹${tooltip.high.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                </div>
                <div className="font-mono tabular-nums">
                  Low:{' '}
                  {tooltip.low != null ? `₹${tooltip.low.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                </div>
                <div className="font-mono tabular-nums">
                  Last paid:{' '}
                  {tooltip.lastPaid != null
                    ? `₹${tooltip.lastPaid.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : '—'}
                </div>
              </div>
            )}
          />
          <Line
            type="monotone"
            dataKey="avgRate"
            stroke="#f59e0b"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function formatRupee(n: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(n)
}

const industrialMono = 'font-[family-name:var(--font-designing-queue),ui-monospace]'
/** JetBrains Mono (dashboard variable) — GRN ledger qty / balance. */
const ledgerMono = 'font-designing-queue tabular-nums tracking-tight'

type GrnReceiptRow = {
  id: string
  receiptDate: string
  receivedQty: number
  vehicleNumber: string
  scaleSlipId: string
  receivedByName: string
  createdAt: string
  qcStatus: string | null
  qcComplete: boolean
  qtyAcceptedStandard: number | null
  qtyAcceptedPenalty: number | null
  qtyRejected: number | null
  rejectionReason: string | null
  rejectionRemarks: string | null
  returnGatePassGeneratedAt: string | null
  qcAccruedPayableInr: number | null
  qcDetails: {
    actualGsm: number | null
    shadeMatch: boolean | null
    surfaceCleanliness: boolean | null
    qcRemarks: string | null
    qcPerformedByUserId: string | null
    qcPerformedAt: string
  } | null
  penaltyRecommendedInr?: number | null
  penaltyShortfallPct?: number | null
  penaltyInvoiceRatePerKg?: number | null
  penaltyProofLines?: string[] | null
  qualityDebitNote?: { id: string; status: string } | null
}

type GrnLedger = {
  vendorPoId: string
  poNumber: string
  status: string
  orderedKg: number
  orderedGsm: number | null
  invoiceRatePerKg: number | null
  totalReceivedKg: number
  totalUsableReceivedKg: number
  outstandingKg: number
  accruedReceiptPayableInr: number
  receiptBreakdownStockKg: number
  receiptBreakdownPenaltyKg: number
  receiptBreakdownReturnKg: number
  receipts: GrnReceiptRow[]
}

type PenaltyFlowState = {
  receiptId: string
  orderedGsm: number
  actualGsm: number
  shortfallPct: number
  recommendedInr: number
  rate: number
  penaltyQtyKg: number
  proofLines: string[]
}

type ShortageActionModalState = {
  vendorPoId: string
  rejectKg: number
  deferredPenalty: PenaltyFlowState | null
}

function coalesceGrnLedger(j: GrnLedger): GrnLedger {
  return {
    ...j,
    accruedReceiptPayableInr: j.accruedReceiptPayableInr ?? 0,
    receiptBreakdownStockKg: j.receiptBreakdownStockKg ?? 0,
    receiptBreakdownPenaltyKg: j.receiptBreakdownPenaltyKg ?? 0,
    receiptBreakdownReturnKg: j.receiptBreakdownReturnKg ?? 0,
    receipts: j.receipts.map((r) => ({
      ...r,
      qcComplete:
        r.qcComplete ??
        Boolean(r.qcStatus && ['PASSED', 'FAILED', 'PASSED_WITH_PENALTY'].includes(r.qcStatus)),
      qtyAcceptedStandard: r.qtyAcceptedStandard ?? null,
      qtyAcceptedPenalty: r.qtyAcceptedPenalty ?? null,
      qtyRejected: r.qtyRejected ?? null,
      rejectionReason: r.rejectionReason ?? null,
      rejectionRemarks: r.rejectionRemarks ?? null,
      returnGatePassGeneratedAt: r.returnGatePassGeneratedAt ?? null,
      qcAccruedPayableInr: r.qcAccruedPayableInr ?? null,
    })),
  }
}

function cashTermsBadgeClass(band: CashFlowTerms['termsBand']): string {
  if (band === 'credit') return 'border-emerald-500/55 text-emerald-200 bg-emerald-500/12'
  if (band === 'near_cash') return 'border-ds-warning/55 text-ds-ink bg-ds-warning/15'
  return 'border-rose-500/65 text-rose-100 bg-rose-950/50 animate-pulse'
}

function procurementHudBadgeClass(variant: ProcurementHud['variant']): string {
  switch (variant) {
    case 'mill_dispatched':
      return 'border-ds-line/50 text-ds-ink bg-neutral-400/15'
    case 'in_transit':
      return 'border-sky-500/50 text-sky-100 bg-blue-500/20'
    case 'in_transit_stale':
      return 'border-ds-warning/60 text-ds-ink bg-blue-500/20 animate-pulse'
    case 'at_gate':
      return 'border-emerald-500/50 text-emerald-100 bg-emerald-500/20'
    case 'short_closed':
      return 'border-ds-line/60 bg-ds-elevated/50 text-ds-ink-muted'
    case 'received':
      return 'border-emerald-600/50 text-emerald-200 bg-emerald-950/35'
    case 'planned':
      return 'border-ds-line/50 text-ds-ink-muted bg-ds-main/60'
    case 'ordered':
      return 'border-sky-500/50 text-sky-200 bg-sky-950/40'
    case 'mixed':
    default:
      return 'border-ds-warning/50 text-ds-warning bg-ds-warning/10'
  }
}

function varianceBadgeClass(level: WeightVarianceAgg['level']): string {
  if (level === 'slate') return 'border-ds-line/50 text-ds-ink-muted bg-ds-main/50'
  if (level === 'amber') return 'border-ds-warning/60 text-ds-ink bg-ds-warning/10'
  return 'border-rose-500/65 text-rose-100 bg-rose-950/45'
}

function ReliabilityBadge({ rel }: { rel: SupplierReliability | null }) {
  if (!rel) {
    return (
      <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-ds-line/50 bg-ds-card px-1 text-[9px] font-black text-neutral-600">
        —
      </span>
    )
  }
  const cls =
    rel.grade === 'A'
      ? 'border-emerald-500/70 bg-emerald-950/45 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.25)]'
      : rel.grade === 'B'
        ? 'border-ds-warning/65 bg-ds-warning/10 text-ds-ink'
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
  if (level === 'at_risk') return 'border-ds-warning/65 text-ds-ink bg-ds-warning/10 font-semibold'
  return 'border-emerald-800/50 text-emerald-200/90 bg-emerald-950/30'
}

function leadBufferRowGlow(lb: LeadBuffer | null): string {
  if (!lb) return ''
  if (lb.level === 'critical') {
    return 'shadow-[0_0_26px_rgba(244,63,94,0.42)] ring-1 ring-rose-500/55 animate-pulse'
  }
  if (lb.level === 'at_risk') {
    if (lb.drivenByReplacementEta) {
      return 'shadow-[0_0_22px_rgba(245,158,11,0.38)] ring-1 ring-ds-warning/35 animate-pulse'
    }
    return 'shadow-[0_0_20px_rgba(245,158,11,0.28)] ring-1 ring-ds-warning/35'
  }
  return ''
}

function daysSinceRequest(iso: string): number {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return (Date.now() - t) / 86_400_000
}

function ProcurementLandedCostPanel({
  landedCost,
  primaryVendorPoNumber,
  requirementKey,
  debouncedQ,
  riskFilterHigh,
  vendorRiskFilterHigh,
  stockOutRiskFilterHigh,
  loadRequirements,
  setSpotlightRow,
}: {
  landedCost: LandedCostSnapshot
  primaryVendorPoNumber: string | null
  requirementKey: string
  debouncedQ: string
  riskFilterHigh: boolean
  vendorRiskFilterHigh: boolean
  stockOutRiskFilterHigh: boolean
  loadRequirements: (
    q: string,
    riskHighOnly: boolean,
    vendorRiskHighOnly: boolean,
    stockOutRiskOnly: boolean,
  ) => Promise<Requirement[] | null>
  setSpotlightRow: Dispatch<SetStateAction<Requirement | null>>
}) {
  const lineId = landedCost.vendorMaterialLineId
  const basic = landedCost.basicRatePerKg
  const w = landedCost.totalWeightKg

  const [freightStr, setFreightStr] = useState(() => String(landedCost.freightTotalInr ?? 0))
  const [unloadStr, setUnloadStr] = useState(() => String(landedCost.unloadingChargesInr ?? 0))
  const [insStr, setInsStr] = useState(() => String(landedCost.insuranceMiscInr ?? 0))

  const savedSigRef = useRef(
    `${landedCost.freightTotalInr ?? 0}|${landedCost.unloadingChargesInr ?? 0}|${landedCost.insuranceMiscInr ?? 0}`,
  )

  const preview = useMemo(() => {
    if (basic == null || !Number.isFinite(basic) || w <= 0 || !lineId) {
      return {
        liveLanded: null as number | null,
        liveFreightPct: null as number | null,
        highLogistics: false,
      }
    }
    const f = Math.max(0, parseFloat(freightStr) || 0)
    const u = Math.max(0, parseFloat(unloadStr) || 0)
    const ins = Math.max(0, parseFloat(insStr) || 0)
    const liveLanded = computeLandedRatePerKg({
      basicRatePerKg: basic,
      totalWeightKg: w,
      freightTotalInr: f,
      unloadingChargesInr: u,
      insuranceMiscInr: ins,
    })
    const liveFreightPct = freightPctOfBasicRate(basic, w, f)
    const highLogistics = isHighLogisticsCostVsBasic(basic, liveLanded, 10)
    return { liveLanded, liveFreightPct, highLogistics }
  }, [basic, w, lineId, freightStr, unloadStr, insStr])

  useEffect(() => {
    if (!lineId || basic == null) return
    const f = Math.max(0, parseFloat(freightStr) || 0)
    const u = Math.max(0, parseFloat(unloadStr) || 0)
    const ins = Math.max(0, parseFloat(insStr) || 0)
    const sig = `${f}|${u}|${ins}`
    if (sig === savedSigRef.current) return

    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/procurement/vendor-material-lines/${lineId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              freightTotalInr: f,
              unloadingChargesInr: u,
              insuranceMiscInr: ins,
            }),
          })
          if (!res.ok) return
          const json = (await res.json()) as {
            freightTotalInr: unknown
            unloadingChargesInr: unknown
            insuranceMiscInr: unknown
            landedRatePerKg: unknown
            totalWeightKg: unknown
          }
          savedSigRef.current = sig
          const lr = json.landedRatePerKg != null ? Number(json.landedRatePerKg) : 0
          await fetch('/api/procurement/landed-cost-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              vendorMaterialLineId: lineId,
              landedRatePerKg: lr,
              vendorPoNumber: primaryVendorPoNumber ?? undefined,
            }),
          })
          void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
          setSpotlightRow((prev) => {
            if (!prev || prev.key !== requirementKey) return prev
            const b = prev.landedCost.basicRatePerKg
            const tw = Number(json.totalWeightKg)
            const fr = Number(json.freightTotalInr)
            return {
              ...prev,
              landedCost: {
                ...prev.landedCost,
                freightTotalInr: fr,
                unloadingChargesInr: Number(json.unloadingChargesInr),
                insuranceMiscInr: Number(json.insuranceMiscInr),
                landedRatePerKg: lr,
                freightPctOfBasic:
                  b != null && b > 0
                    ? freightPctOfBasicRate(b, tw, fr)
                    : prev.landedCost.freightPctOfBasic,
              },
            }
          })
        } catch {
          /* noop */
        }
      })()
    }, 750)
    return () => window.clearTimeout(t)
  }, [
    freightStr,
    unloadStr,
    insStr,
    lineId,
    basic,
    requirementKey,
    primaryVendorPoNumber,
    debouncedQ,
    riskFilterHigh,
    vendorRiskFilterHigh,
    stockOutRiskFilterHigh,
    loadRequirements,
    setSpotlightRow,
  ])

  if (!lineId || basic == null) {
    return (
      <div className="rounded-lg border border-ds-line/40 bg-background px-3 py-2 text-[11px] text-neutral-500">
        Landed cost needs a linked mill PO line with a basic ₹/kg rate.
      </div>
    )
  }

  const { liveLanded, liveFreightPct, highLogistics } = preview

  return (
    <div
      className="rounded-lg border border-ds-line/40 bg-background p-3 space-y-2"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <p className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold">
        Landed cost calculator
      </p>
      {highLogistics ? (
        <div className="rounded-md border border-ds-warning/40 bg-ds-warning/8 px-2 py-1.5 text-[10px] text-ds-warning leading-snug">
          High logistics cost: total uplift vs basic rate exceeds 10%. Review freight, unloading, and
          insurance allocations.
        </div>
      ) : null}
      <div className={`space-y-2 text-[11px] ${ledgerMono}`}>
        <div className="flex justify-between gap-2 text-ds-ink-muted">
          <span>Basic rate (PO)</span>
          <span className="text-ds-ink">
            ₹{basic.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/kg
          </span>
        </div>
        <p className="text-[9px] text-neutral-600">
          PO weight basis:{' '}
          {w.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg (mill line)
        </p>
        <label className="block text-ds-ink-faint">
          Freight total (₹)
          <input
            type="number"
            min={0}
            step={0.01}
            value={freightStr}
            onChange={(e) => setFreightStr(e.target.value)}
            className="mt-0.5 w-full rounded border border-ds-line/50 bg-ds-main px-2 py-1 text-ds-ink"
          />
        </label>
        <label className="block text-ds-ink-faint">
          Unloading charges (₹)
          <input
            type="number"
            min={0}
            step={0.01}
            value={unloadStr}
            onChange={(e) => setUnloadStr(e.target.value)}
            className="mt-0.5 w-full rounded border border-ds-line/50 bg-ds-main px-2 py-1 text-ds-ink"
          />
        </label>
        <label className="block text-ds-ink-faint">
          Insurance & misc (₹)
          <input
            type="number"
            min={0}
            step={0.01}
            value={insStr}
            onChange={(e) => setInsStr(e.target.value)}
            className="mt-0.5 w-full rounded border border-ds-line/50 bg-ds-main px-2 py-1 text-ds-ink"
          />
        </label>
        <div className="border-t border-ds-line/40 pt-2 mt-1 space-y-1">
          <div className="flex justify-between gap-2">
            <span className="text-ds-ink-faint">Landed rate</span>
            <span className={`font-semibold ${STRATEGIC_SOURCING_GOLD}`}>
              {liveLanded != null
                ? `₹${liveLanded.toLocaleString('en-IN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 4,
                  })}/kg`
                : '—'}
            </span>
          </div>
          <p className="text-[9px] text-neutral-500">
            Freight vs basic:{' '}
            {liveFreightPct != null ? `${liveFreightPct.toFixed(1)}%` : '—'} · Auto-saves after edit
          </p>
        </div>
      </div>
    </div>
  )
}

export default function ProcurementWorkbenchPage() {
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [sortByPaymentDate, setSortByPaymentDate] = useState(false)
  const displayRequirements = useMemo(() => {
    if (!sortByPaymentDate) return requirements
    return [...requirements].sort((a, b) => {
      const pa = a.cashFlowTerms.projectedPaymentYmd
      const pb = b.cashFlowTerms.projectedPaymentYmd
      if (pa == null && pb == null) return 0
      if (pa == null) return 1
      if (pb == null) return -1
      return pa.localeCompare(pb)
    })
  }, [requirements, sortByPaymentDate])
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
  const [priceIntel, setPriceIntel] = useState<PriceIntelBundle | null>(null)
  const [benchByLineKey, setBenchByLineKey] = useState<Record<string, PriceIntelBundle>>({})
  const priceBenchmarkAuditLoggedRef = useRef<Set<string>>(new Set())
  const cashFlowAuditLoggedRef = useRef<Set<string>>(new Set())
  const [priceIntelLoading, setPriceIntelLoading] = useState(false)
  const [supplierPerf, setSupplierPerf] = useState<{ avgDaysLate: number | null; sampleSize: number } | null>(null)
  const [atRiskVendorPoCount, setAtRiskVendorPoCount] = useState(0)
  const [vendorRiskIndexCount, setVendorRiskIndexCount] = useState(0)
  const [stockOutRisksCount, setStockOutRisksCount] = useState(0)
  const [stockOutRiskFilterHigh, setStockOutRiskFilterHigh] = useState(false)
  const [policyMinInput, setPolicyMinInput] = useState('')
  const [policyMaxInput, setPolicyMaxInput] = useState('')
  const [policySaving, setPolicySaving] = useState(false)
  const [draftReorderSubmitting, setDraftReorderSubmitting] = useState(false)
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
  const [grnLedger, setGrnLedger] = useState<GrnLedger | null>(null)
  const [grnLoading, setGrnLoading] = useState(false)
  const [grnExpanded, setGrnExpanded] = useState(false)
  const [grnReceiptDate, setGrnReceiptDate] = useState('')
  const [grnReceivedQty, setGrnReceivedQty] = useState('')
  const [grnVehicle, setGrnVehicle] = useState('')
  const [grnScaleSlip, setGrnScaleSlip] = useState('')
  const [grnSaving, setGrnSaving] = useState(false)
  const [grnQcReceiptId, setGrnQcReceiptId] = useState<string | null>(null)
  const [grnQcActualGsm, setGrnQcActualGsm] = useState('')
  const [grnQcShadeMatch, setGrnQcShadeMatch] = useState(true)
  const [grnQcSurfaceClean, setGrnQcSurfaceClean] = useState(true)
  const [grnQcRemarks, setGrnQcRemarks] = useState('')
  const [grnQcQtyStandard, setGrnQcQtyStandard] = useState('')
  const [grnQcQtyPenalty, setGrnQcQtyPenalty] = useState('')
  const [grnQcQtyRejected, setGrnQcQtyRejected] = useState('')
  const [grnQcRejectionReason, setGrnQcRejectionReason] = useState('')
  const [grnQcRejectionRemarks, setGrnQcRejectionRemarks] = useState('')
  const [grnQcSaving, setGrnQcSaving] = useState(false)
  const [penaltyFlow, setPenaltyFlow] = useState<PenaltyFlowState | null>(null)
  const [returnPassWorkingId, setReturnPassWorkingId] = useState<string | null>(null)
  const [debitDraftSubmitting, setDebitDraftSubmitting] = useState(false)
  const [shortageActionModal, setShortageActionModal] = useState<ShortageActionModalState | null>(null)
  const [shortageReplacementEta, setShortageReplacementEta] = useState('')
  const [shortageShortCloseRemarks, setShortageShortCloseRemarks] = useState('')
  const [shortageActionSubmitting, setShortageActionSubmitting] = useState<'replacement' | 'short_close' | null>(
    null,
  )

  const loadRequirements = useCallback(
    async (qArg: string, riskHighOnly: boolean, vendorRiskHighOnly: boolean, stockOutRiskOnly: boolean) => {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        if (qArg.trim()) params.set('q', qArg.trim())
        if (riskHighOnly) params.set('risk', 'high')
        if (vendorRiskHighOnly) params.set('vendorRisk', 'high')
        if (stockOutRiskOnly) params.set('stockOutRisk', 'high')
        const qs = params.toString() ? `?${params.toString()}` : ''
        const res = await fetch(`/api/procurement/material-requirements${qs}`)
        const json = (await res.json()) as {
          requirements?: Requirement[]
          lineReconciliations?: Record<string, LineReconciliationDto>
          suggestedSupplier?: { id: string; name: string } | null
          vitals?: MaterialVitals
          atRiskVendorPoCount?: number
          vendorRiskIndexCount?: number
          stockOutRisksCount?: number
          canAuthorizeShortClose?: boolean
          factoryTimeZone?: string
          error?: string
        }
        if (!res.ok) throw new Error(json.error || 'Failed to load requirements')
        const list = (json.requirements ?? []).map((r) => ({
          ...r,
          procurementHud: {
            ...r.procurementHud,
            shortageAwaitingReplacement: r.procurementHud.shortageAwaitingReplacement ?? false,
          },
        }))
        setRequirements(list)
        setLineReconciliations(json.lineReconciliations ?? {})
        setVitals(json.vitals ?? null)
        setAtRiskVendorPoCount(json.atRiskVendorPoCount ?? 0)
        setVendorRiskIndexCount(json.vendorRiskIndexCount ?? 0)
        setStockOutRisksCount(json.stockOutRisksCount ?? 0)
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
    if (!spotlightRow) {
      setPolicyMinInput('')
      setPolicyMaxInput('')
      return
    }
    setPolicyMinInput(String(spotlightRow.reorderRadar.minimumThreshold))
    setPolicyMaxInput(String(spotlightRow.reorderRadar.maximumBuffer))
  }, [spotlightRow?.key])

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
    void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
  }, [debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh, loadRequirements])

  useEffect(() => {
    const onPri = () => {
      void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
    }
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh, loadRequirements])

  useEffect(() => {
    const onPaper = () => {
      void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
    }
    window.addEventListener('ci-paper-consumed', onPaper)
    return () => window.removeEventListener('ci-paper-consumed', onPaper)
  }, [debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh, loadRequirements])

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
      setGrnLedger(null)
      setGrnExpanded(false)
      setGrnReceiptDate('')
      setGrnReceivedQty('')
      setGrnVehicle('')
      setGrnScaleSlip('')
      setGrnQcReceiptId(null)
      setGrnQcActualGsm('')
      setGrnQcRemarks('')
      setGrnQcQtyStandard('')
      setGrnQcQtyPenalty('')
      setGrnQcQtyRejected('')
      setGrnQcRejectionReason('')
      setGrnQcRejectionRemarks('')
      setPenaltyFlow(null)
      setShortageActionModal(null)
    }
  }, [spotlightRow])

  useEffect(() => {
    if (shortageActionModal) {
      setShortageReplacementEta('')
      setShortageShortCloseRemarks('')
    }
  }, [shortageActionModal])

  useEffect(() => {
    const poId = spotlightRow?.procurementHud.primaryVendorPoId
    if (!poId) {
      setGrnLedger(null)
      return
    }
    let cancelled = false
    setGrnLoading(true)
    void (async () => {
      try {
        const res = await fetch(`/api/procurement/vendor-pos/${encodeURIComponent(poId)}/receipts`)
        const json = (await res.json()) as GrnLedger & { error?: string }
        if (!res.ok || cancelled) {
          if (!cancelled) setGrnLedger(null)
          return
        }
        if (!cancelled) setGrnLedger(coalesceGrnLedger(json as GrnLedger))
      } catch {
        if (!cancelled) setGrnLedger(null)
      } finally {
        if (!cancelled) setGrnLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [spotlightRow?.procurementHud.primaryVendorPoId])

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
        const piJson = (await piRes.json()) as Partial<PriceIntelBundle> & { error?: string }
        if (piRes.ok) {
          setPriceIntel({
            history: piJson.history ?? [],
            lastPurchaseRate: piJson.lastPurchaseRate ?? null,
            benchmark30d: piJson.benchmark30d ?? null,
            trend6m: piJson.trend6m ?? [],
            trendTooltip: piJson.trendTooltip ?? { high: null, low: null, lastPaid: null },
          })
        }
        if (perfRes && perfRes.ok) {
          const p = (await perfRes.json()) as { avgDaysLate: number | null; sampleSize: number }
          setSupplierPerf(p)
        }
      } catch {
        setPriceIntel(emptyPriceIntelBundle())
      } finally {
        setPriceIntelLoading(false)
      }
    })()
  }, [spotlightRow])

  useEffect(() => {
    if (!spotlightRow?.cashFlowTerms.projectedPaymentYmd) return
    const key = spotlightRow.key
    if (cashFlowAuditLoggedRef.current.has(key)) return
    cashFlowAuditLoggedRef.current.add(key)
    void (async () => {
      try {
        const res = await fetch('/api/procurement/cash-flow-audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requirementKey: key,
            projectedPaymentYmd: spotlightRow.cashFlowTerms.projectedPaymentYmd,
            vendorPoNumber: spotlightRow.procurementHud.primaryVendorPoNumber ?? undefined,
          }),
        })
        if (!res.ok) cashFlowAuditLoggedRef.current.delete(key)
      } catch {
        cashFlowAuditLoggedRef.current.delete(key)
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
    setBenchByLineKey({})
    priceBenchmarkAuditLoggedRef.current = new Set()
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setDraftLoading(false)
    }
  }

  useEffect(() => {
    if (!draft?.lines?.length) {
      setBenchByLineKey({})
      return
    }
    const uniq = new Map<string, { bg: string; gsm: number }>()
    for (const ln of draft.lines) {
      uniq.set(`${ln.boardGrade}|${ln.gsm}`, { bg: ln.boardGrade, gsm: ln.gsm })
    }
    let cancelled = false
    void (async () => {
      const out: Record<string, PriceIntelBundle> = {}
      await Promise.all(
        Array.from(uniq.values()).map(async ({ bg, gsm }) => {
          const key = `${bg}|${gsm}`
          try {
            const res = await fetch(
              `/api/procurement/board-price-intel?boardGrade=${encodeURIComponent(bg)}&gsm=${encodeURIComponent(String(gsm))}`,
            )
            const j = (await res.json()) as Partial<PriceIntelBundle>
            if (res.ok) {
              out[key] = {
                history: j.history ?? [],
                lastPurchaseRate: j.lastPurchaseRate ?? null,
                benchmark30d: j.benchmark30d ?? null,
                trend6m: j.trend6m ?? [],
                trendTooltip: j.trendTooltip ?? { high: null, low: null, lastPaid: null },
              }
            }
          } catch {
            /* noop */
          }
        }),
      )
      if (!cancelled) {
        setBenchByLineKey(out)
        const first = draft.lines[0]
        if (first) {
          const b = out[`${first.boardGrade}|${first.gsm}`]
          const benchR = b?.benchmark30d?.ratePerKg
          if (benchR != null && benchR > 0) setLastPurchaseBenchmark(benchR)
          else if (b?.lastPurchaseRate != null && b.lastPurchaseRate > 0)
            setLastPurchaseBenchmark(b.lastPurchaseRate)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [draft?.id])

  useEffect(() => {
    if (!draft?.id || !draft.lines.length) return
    const t = window.setTimeout(() => {
      void (async () => {
        for (const ln of draft.lines) {
          const key = `${ln.boardGrade}|${ln.gsm}`
          const bundle = benchByLineKey[key]
          const b = bundle?.benchmark30d
          const raw = lineRates[ln.id] ?? ''
          const num = raw === '' ? NaN : Number(raw)
          if (!b || !Number.isFinite(num) || num <= 0) continue
          const v = computePriceVariancePct(num, b.ratePerKg)
          if (v > PRICE_BENCHMARK_WARN_THRESHOLD_PCT) {
            const auditKey = `${draft.id}-${ln.id}`
            if (priceBenchmarkAuditLoggedRef.current.has(auditKey)) continue
            priceBenchmarkAuditLoggedRef.current.add(auditKey)
            try {
              const res = await fetch('/api/procurement/price-benchmark-audit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  boardGrade: ln.boardGrade,
                  gsm: ln.gsm,
                  variancePct: v,
                  currentRatePerKg: num,
                  benchmarkRatePerKg: b.ratePerKg,
                  benchmarkSupplierName: b.supplierName,
                }),
              })
              if (!res.ok) priceBenchmarkAuditLoggedRef.current.delete(auditKey)
            } catch {
              priceBenchmarkAuditLoggedRef.current.delete(auditKey)
            }
          }
        }
      })()
    }, 700)
    return () => window.clearTimeout(t)
  }, [draft?.id, lineRates, benchByLineKey])

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
      await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
      if (json.id) await openDraft(json.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setGenerating(false)
    }
  }

  async function saveReorderPolicyFromSpotlight() {
    if (!spotlightRow) return
    setPolicySaving(true)
    try {
      const res = await fetch('/api/procurement/reorder-radar/policy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          radarKey: spotlightRow.key,
          minimumThreshold: Math.max(0, parseInt(policyMinInput, 10) || 0),
          maximumBuffer: Math.max(0, parseInt(policyMaxInput, 10) || 0),
        }),
      })
      const j = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(j.error || 'Save failed')
      toast.success('Safety buffer saved')
      const list = await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
      if (list) {
        const u = list.find((x) => x.key === spotlightRow.key)
        if (u) setSpotlightRow(u)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setPolicySaving(false)
    }
  }

  async function draftReorderPoFromSpotlight() {
    if (!spotlightRow) return
    setDraftReorderSubmitting(true)
    try {
      const res = await fetch('/api/procurement/reorder-radar/draft-vendor-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirementKey: spotlightRow.key }),
      })
      const j = (await res.json()) as { id?: string; poNumber?: string; error?: string }
      if (!res.ok) throw new Error(j.error || 'Draft failed')
      toast.success(j.poNumber ? `Draft mill PO ${j.poNumber}` : 'Draft mill PO created')
      await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
      if (j.id) await openDraft(j.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setDraftReorderSubmitting(false)
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
      await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
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
      void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
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
      await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
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
      await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
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
      const list = await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
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

  async function submitGrnQcSplit() {
    const poId = spotlightRow?.procurementHud.primaryVendorPoId
    const receiptId = grnQcReceiptId
    if (!poId || !receiptId || !grnLedger) return
    const rec = grnLedger.receipts.find((r) => r.id === receiptId)
    if (!rec) return
    const actual = Number(grnQcActualGsm)
    if (!Number.isFinite(actual) || actual <= 0) {
      toast.error('Enter actual GSM (positive number)')
      return
    }
    const std = Number(grnQcQtyStandard)
    const pen = Number(grnQcQtyPenalty)
    const rej = Number(grnQcQtyRejected)
    if (![std, pen, rej].every((n) => Number.isFinite(n) && n >= 0)) {
      toast.error('Enter non-negative quantities for standard, penalty, and rejected tranches')
      return
    }
    const sum = std + pen + rej
    if (Math.abs(sum - rec.receivedQty) > 1e-4) {
      toast.error(
        `Split must equal gate weight: ${rec.receivedQty.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg (currently ${sum.toLocaleString('en-IN', { maximumFractionDigits: 3 })})`,
      )
      return
    }
    if (rej > 0) {
      if (!grnQcRejectionReason || !(GRN_REJECTION_REASONS as readonly string[]).includes(grnQcRejectionReason)) {
        toast.error('Choose a rejection reason when return qty > 0')
        return
      }
      if (grnQcRejectionRemarks.trim().length < 3) {
        toast.error('Rejection remarks required (min 3 characters)')
        return
      }
    }
    setGrnQcSaving(true)
    try {
      const res = await fetch(
        `/api/procurement/vendor-pos/${encodeURIComponent(poId)}/receipts/${encodeURIComponent(receiptId)}/qc`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            qcDetails: {
              qtyAcceptedStandard: std,
              qtyAcceptedPenalty: pen,
              qtyRejected: rej,
              actualGsm: actual,
              shadeMatch: grnQcShadeMatch,
              surfaceCleanliness: grnQcSurfaceClean,
              qcRemarks: grnQcRemarks.trim() || null,
              rejectionReason: rej > 0 ? grnQcRejectionReason : null,
              rejectionRemarks: rej > 0 ? grnQcRejectionRemarks.trim() : null,
            },
          }),
        },
      )
      const json = (await res.json()) as {
        error?: string
        message?: string
        criticalGsmVariance?: boolean
        orderedGsm?: number | null
        penaltyRecommendedInr?: number | null
        technicalShortfallPct?: number | null
        invoiceRatePerKg?: number | null
        penaltyProofLines?: string[] | null
        qcStatus?: string
        qtyAcceptedPenalty?: number
        qtyRejected?: number
      }
      if (!res.ok) throw new Error(json.error || 'QC save failed')
      toast.success(json.message ?? 'QC recorded')
      if (json.criticalGsmVariance) {
        toast.warning(
          `Critical GSM variance — notify ${PROCUREMENT_LOGISTICS_AUDIT_ACTOR}: actual ${actual} vs ordered ${json.orderedGsm ?? '—'} (>5% deviation).`,
          { duration: 12_000 },
        )
      }
      const doneId = receiptId
      const qtyRejectedAfter = json.qtyRejected ?? rej
      let deferredPenalty: PenaltyFlowState | null = null
      if (
        json.qcStatus === 'PASSED_WITH_PENALTY' &&
        json.penaltyRecommendedInr != null &&
        json.penaltyRecommendedInr > 0 &&
        json.penaltyProofLines &&
        json.penaltyProofLines.length > 0
      ) {
        deferredPenalty = {
          receiptId: doneId,
          orderedGsm: json.orderedGsm ?? grnLedger.orderedGsm ?? spotlightRow?.gsm ?? 0,
          actualGsm: actual,
          shortfallPct: json.technicalShortfallPct ?? 0,
          recommendedInr: json.penaltyRecommendedInr,
          rate: json.invoiceRatePerKg ?? grnLedger.invoiceRatePerKg ?? 0,
          penaltyQtyKg: json.qtyAcceptedPenalty ?? pen,
          proofLines: json.penaltyProofLines,
        }
      }
      if (qtyRejectedAfter > 0) {
        setPenaltyFlow(null)
        setShortageActionModal({
          vendorPoId: poId,
          rejectKg: qtyRejectedAfter,
          deferredPenalty,
        })
      } else {
        setShortageActionModal(null)
        setPenaltyFlow(deferredPenalty)
      }
      setGrnQcReceiptId(null)
      setGrnQcRemarks('')
      setGrnQcQtyStandard('')
      setGrnQcQtyPenalty('')
      setGrnQcQtyRejected('')
      setGrnQcRejectionReason('')
      setGrnQcRejectionRemarks('')
      const r2 = await fetch(`/api/procurement/vendor-pos/${encodeURIComponent(poId)}/receipts`)
      if (r2.ok) setGrnLedger(coalesceGrnLedger((await r2.json()) as GrnLedger))
      const list = await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
      if (list && spotlightRow) {
        const u = list.find((x) => x.key === spotlightRow.key)
        if (u) setSpotlightRow(u)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'QC failed')
    } finally {
      setGrnQcSaving(false)
    }
  }

  async function generateReturnGatePass(receiptId: string) {
    const poId = spotlightRow?.procurementHud.primaryVendorPoId
    if (!poId) return
    setReturnPassWorkingId(receiptId)
    try {
      const res = await fetch(
        `/api/procurement/vendor-pos/${encodeURIComponent(poId)}/receipts/${encodeURIComponent(receiptId)}/return-gate-pass`,
        { method: 'POST' },
      )
      const json = (await res.json()) as { error?: string; html?: string; auditMessage?: string }
      if (!res.ok) throw new Error(json.error || 'Could not generate return pass')
      const html = json.html ?? ''
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const w = window.open(url, '_blank', 'noopener,noreferrer')
      if (w) {
        w.addEventListener('load', () => {
          window.setTimeout(() => {
            try {
              w.print()
            } catch {
              /* noop */
            }
          }, 200)
        })
      }
      toast.success(json.auditMessage ?? 'Return gate pass opened for print')
      const r2 = await fetch(`/api/procurement/vendor-pos/${encodeURIComponent(poId)}/receipts`)
      if (r2.ok) setGrnLedger(coalesceGrnLedger((await r2.json()) as GrnLedger))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Return pass failed')
    } finally {
      setReturnPassWorkingId(null)
    }
  }

  async function submitDebitDraft(receiptId: string) {
    const poId = spotlightRow?.procurementHud.primaryVendorPoId
    if (!poId) return
    setDebitDraftSubmitting(true)
    try {
      const res = await fetch(
        `/api/procurement/vendor-pos/${encodeURIComponent(poId)}/receipts/${encodeURIComponent(receiptId)}/debit-draft`,
        { method: 'POST' },
      )
      const json = (await res.json()) as { error?: string; message?: string }
      if (!res.ok) throw new Error(json.error || 'Draft failed')
      toast.success(json.message ?? 'Debit draft queued for finance')
      setPenaltyFlow(null)
      const r2 = await fetch(`/api/procurement/vendor-pos/${encodeURIComponent(poId)}/receipts`)
      if (r2.ok) setGrnLedger(coalesceGrnLedger((await r2.json()) as GrnLedger))
      void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Draft failed')
    } finally {
      setDebitDraftSubmitting(false)
    }
  }

  async function submitShortageReplacement() {
    const m = shortageActionModal
    if (!m || !shortageReplacementEta.trim()) {
      toast.error('Enter replacement ETA (date & time)')
      return
    }
    const etaMs = new Date(shortageReplacementEta).getTime()
    if (!Number.isFinite(etaMs)) {
      toast.error('Invalid replacement ETA')
      return
    }
    setShortageActionSubmitting('replacement')
    try {
      const res = await fetch(
        `/api/procurement/vendor-pos/${encodeURIComponent(m.vendorPoId)}/shortage-replacement`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rejectKg: m.rejectKg,
            replacementEtaAt: new Date(shortageReplacementEta).toISOString(),
          }),
        },
      )
      const json = (await res.json()) as { error?: string; message?: string }
      if (!res.ok) throw new Error(json.error || 'Could not record replacement')
      toast.success(json.message ?? 'Replacement ETA committed')
      const def = m.deferredPenalty
      setShortageActionModal(null)
      if (def) setPenaltyFlow(def)
      const list = await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
      if (list && spotlightRow) {
        const u = list.find((x) => x.key === spotlightRow.key)
        if (u) setSpotlightRow(u)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Replacement save failed')
    } finally {
      setShortageActionSubmitting(null)
    }
  }

  async function submitShortageShortClose() {
    const m = shortageActionModal
    if (!m) return
    if (!canAuthorizeShortClose) {
      toast.error('Short-close requires md, director, or procurement_manager role')
      return
    }
    const remarks = shortageShortCloseRemarks.trim()
    if (remarks.length < 10) {
      toast.error('Remarks required (min 10 characters) for short-close')
      return
    }
    setShortageActionSubmitting('short_close')
    try {
      const res = await fetch(`/api/procurement/vendor-pos/${encodeURIComponent(m.vendorPoId)}/short-close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Rejection shortage — short-close',
          remarks,
          rejectionShortClose: true,
          rejectKg: m.rejectKg,
        }),
      })
      const json = (await res.json()) as { error?: string; message?: string }
      if (!res.ok) throw new Error(json.error || 'Short-close failed')
      toast.success(json.message ?? 'PO closed — short received')
      const def = m.deferredPenalty
      setShortageActionModal(null)
      if (def) setPenaltyFlow(def)
      const list = await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
      if (list && spotlightRow) {
        const u = list.find((x) => x.key === spotlightRow.key)
        if (u) setSpotlightRow(u)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Short-close failed')
    } finally {
      setShortageActionSubmitting(null)
    }
  }

  async function submitGrnReceipt() {
    const poId = spotlightRow?.procurementHud.primaryVendorPoId
    if (!poId || !grnLedger) return
    const qty = Number(grnReceivedQty)
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Enter a positive received quantity (kg)')
      return
    }
    if (!grnReceiptDate.trim()) {
      toast.error('Receipt date is required')
      return
    }
    if (!grnVehicle.trim() || !grnScaleSlip.trim()) {
      toast.error('Vehicle and scale slip ID are required')
      return
    }
    setGrnSaving(true)
    try {
      const res = await fetch(`/api/procurement/vendor-pos/${encodeURIComponent(poId)}/receipts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiptDate: new Date(grnReceiptDate).toISOString(),
          receivedQty: qty,
          vehicleNumber: grnVehicle,
          scaleSlipId: grnScaleSlip,
        }),
      })
      const json = (await res.json()) as { error?: string; message?: string }
      if (!res.ok) throw new Error(json.error || 'Failed to log receipt')
      toast.success(json.message ?? 'Receipt logged')
      setGrnReceivedQty('')
      setGrnVehicle('')
      setGrnScaleSlip('')
      setGrnExpanded(false)
      const r2 = await fetch(`/api/procurement/vendor-pos/${encodeURIComponent(poId)}/receipts`)
      if (r2.ok) {
        const ledger = coalesceGrnLedger((await r2.json()) as GrnLedger)
        setGrnLedger(ledger)
      }
      const list = await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
      if (list && spotlightRow) {
        const u = list.find((x) => x.key === spotlightRow.key)
        if (u) setSpotlightRow(u)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Receipt failed')
    } finally {
      setGrnSaving(false)
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
      const list = await loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)
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
    'ring-1 ring-ring/30 shadow-[0_8px_32px_rgba(0,0,0,0.35)] bg-gradient-to-br from-ds-main/50 to-ds-card/30'

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
            valueClassName="text-ds-warning"
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
            valueClassName={vitals && vitals.criticalShortagePoCount > 0 ? 'text-rose-300' : 'text-ds-ink'}
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
                  : 'text-ds-ink'
            }
            shellClassName={glassKpi}
          />
          <IndustrialKpiTile
            label="Procurement leakage"
            value={vitals ? formatRupee(vitals.procurementLeakageMtdInr ?? 0) : '—'}
            hint="Extra vs 30d benchmark · ordered vendor lines MTD (₹)"
            valueClassName={
              vitals && (vitals.procurementLeakageMtdInr ?? 0) > 0
                ? 'text-rose-200/95 font-mono tabular-nums'
                : 'text-ds-ink font-mono tabular-nums'
            }
            shellClassName={glassKpi}
          />
          <IndustrialKpiTile
            label="Pending payables (30D)"
            value={vitals ? formatRupee(vitals.pendingPayables30dInr ?? 0) : '—'}
            hint="Received mill POs · accrued due within 30 calendar days (₹)"
            valueClassName={
              vitals && (vitals.pendingPayables30dInr ?? 0) > 0
                ? 'text-sky-200/95 font-mono tabular-nums'
                : 'text-ds-ink font-mono tabular-nums'
            }
            shellClassName={glassKpi}
          />
          <IndustrialKpiTile
            label="Monthly weight loss"
            value={vitals ? formatRupee(vitals.monthlyWeightLossInr ?? 0) : '—'}
            hint="Short-weight ₹ value MTD (gate vs invoice)"
            valueClassName={
              vitals && (vitals.monthlyWeightLossInr ?? 0) > 0 ? 'text-rose-200/95 font-mono' : 'text-ds-ink font-mono'
            }
            shellClassName={glassKpi}
          />
          <IndustrialKpiTile
            label="QC pending trucks"
            value={vitals ? vitals.qcPendingTrucksCount ?? 0 : '—'}
            hint="GRN lines on active mill POs · QC not yet performed"
            valueClassName={
              vitals && (vitals.qcPendingTrucksCount ?? 0) > 0 ? 'text-ds-warning font-mono' : 'text-ds-ink font-mono'
            }
            shellClassName={`${glassKpi} ${STRATEGIC_SOURCING_GOLD_BORDER} ${STRATEGIC_SOURCING_GOLD_SOFT}`}
          />
          <IndustrialKpiTile
            label="Total quality recoveries"
            value={vitals ? formatRupee(vitals.qualityRecoveriesMonthInr ?? 0) : '—'}
            hint="Quality debit notes queued this month (₹)"
            valueClassName={
              vitals && (vitals.qualityRecoveriesMonthInr ?? 0) > 0
                ? 'text-ds-warning font-mono'
                : 'text-ds-ink font-mono'
            }
            shellClassName={`${glassKpi} ${STRATEGIC_SOURCING_GOLD_BORDER}`}
          />
          <IndustrialKpiTile
            label="At-risk orders"
            value={atRiskVendorPoCount}
            hint={'Vendor POs · buffer < 48h (IST)'}
            valueClassName={atRiskVendorPoCount > 0 ? 'text-ds-warning' : 'text-ds-ink'}
            shellClassName={glassKpi}
            onClick={() => setRiskFilterHigh((v) => !v)}
            isActive={riskFilterHigh}
          />
          <IndustrialKpiTile
            label="Vendor risk index"
            value={vendorRiskIndexCount}
            hint="Active rows · suggested supplier grade C"
            valueClassName={vendorRiskIndexCount > 0 ? 'text-orange-300/95' : 'text-ds-ink'}
            shellClassName={`${glassKpi} ${
              vendorRiskIndexCount > 0 ? `${STRATEGIC_SOURCING_GOLD_BORDER} ${STRATEGIC_SOURCING_GOLD_SOFT}` : ''
            }`}
            onClick={() => setVendorRiskFilterHigh((v) => !v)}
            isActive={vendorRiskFilterHigh}
          />
          <IndustrialKpiTile
            label="Stock-out risks"
            value={stockOutRisksCount}
            hint="Unique board+GSM buckets · net ≤ min or ≤ 0 sheets"
            valueClassName={stockOutRisksCount > 0 ? 'text-rose-300/95 font-mono tabular-nums' : 'text-ds-ink font-mono tabular-nums'}
            shellClassName={glassKpi}
            onClick={() => setStockOutRiskFilterHigh((v) => !v)}
            isActive={stockOutRiskFilterHigh}
          />
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border/40 bg-ds-main/40 px-3 py-3 backdrop-blur-xl ring-1 ring-ring/20">
        <label className="block flex-1 min-w-[200px]">
          <span className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold">
            Deep relational search
          </span>
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Customer PO #, vendor name, product/carton, JC…"
            className="mt-1 w-full rounded-md border border-ds-line/60 bg-card px-3 py-2 text-sm text-foreground placeholder:text-ds-ink-faint"
          />
        </label>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-ds-ink-faint mb-1">Supplier</label>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="min-w-[14rem] rounded-md border border-ds-line/60 bg-card px-2 py-1.5 text-xs text-foreground"
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
          <p className="text-[11px] text-ds-ink-faint pb-1">
            Suggested: <span className="text-ds-warning">{suggestedSupplier.name}</span>
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
          onClick={() => setSortByPaymentDate((v) => !v)}
          className={`rounded-md border px-3 py-1.5 text-xs ${
            sortByPaymentDate
              ? 'border-emerald-500/50 bg-emerald-950/35 text-emerald-200'
              : 'border-ds-line/60 text-ds-ink-muted hover:bg-ds-card'
          }`}
        >
          {sortByPaymentDate ? 'Sort: payment date ✓' : 'Sort: payment date'}
        </button>
        <button
          type="button"
          onClick={() => void loadRequirements(debouncedQ, riskFilterHigh, vendorRiskFilterHigh, stockOutRiskFilterHigh)}
          className="rounded-md border border-ds-line/60 px-3 py-1.5 text-xs text-ds-ink-muted hover:bg-ds-card"
        >
          Refresh
        </button>
        {riskFilterHigh ? (
          <button
            type="button"
            onClick={() => setRiskFilterHigh(false)}
            className="rounded-md border border-ds-warning/50 bg-ds-warning/10 px-3 py-1.5 text-xs text-ds-warning hover:bg-ds-warning/10"
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
        {stockOutRiskFilterHigh ? (
          <button
            type="button"
            onClick={() => setStockOutRiskFilterHigh(false)}
            className="rounded-md border border-rose-500/50 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-950/50"
          >
            Clear stock-out filter
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="text-ds-ink-faint text-sm">Loading readiness grid…</p>
      ) : displayRequirements.length === 0 ? (
        <p className="text-ds-ink-faint text-sm">
          {vendorRiskFilterHigh && riskFilterHigh
            ? 'No rows match both lead-time stress and high vendor risk for this search. Clear one or both filters.'
            : vendorRiskFilterHigh
              ? 'No active rows with grade C suggested suppliers for this search. Clear the vendor risk filter or refresh after new dispatches and reconciliations.'
              : stockOutRiskFilterHigh
                ? 'No rows in stock-out risk for this search. Clear the stock-out filter or set minimum thresholds on spotlight rows.'
                : riskFilterHigh
                  ? 'No high-risk lead-time rows for this search. Clear the lead-time filter or refresh after updating vendor ETAs.'
                  : 'No active material rows for this search. Confirm customer POs and material queue lines (pending through in-transit).'}
        </p>
      ) : (
        <div className={industrialTableClassName()}>
          <table className="w-full text-left text-[10px] leading-tight border-collapse">
            <thead className="bg-ds-main/90 text-ds-ink-muted border-b border-ds-line/40">
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
                <th className="px-1.5 py-1.5 whitespace-nowrap">Safety</th>
                <th className="px-1.5 py-1.5">Status</th>
                <th className="px-1.5 py-1.5 whitespace-nowrap">Terms</th>
                <th className="px-1.5 py-1.5 text-right whitespace-nowrap">Basic ₹/kg</th>
                <th className="px-1.5 py-1.5 text-right whitespace-nowrap">Landed ₹/kg</th>
                <th className="px-1.5 py-1.5">Age</th>
                <th className="px-1.5 py-1.5 whitespace-nowrap">Risk (IST)</th>
                <th className="px-1.5 py-1.5 whitespace-nowrap">Variance</th>
                <th className="px-1.5 py-1.5 text-right">Tonnage (t)</th>
                <th className="px-1.5 py-1.5">Linked jobs</th>
                <th className="px-1.5 py-1.5">Suggested vendor</th>
              </tr>
            </thead>
            <tbody>
              {displayRequirements.map((r, rowIdx) => {
                const pri = r.industrialPriority
                  ? 'ring-2 ring-orange-500/60 shadow-[0_0_26px_rgba(251,146,60,0.38)] bg-gradient-to-r from-orange-950/25 to-ds-warning/10'
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
                    className={`border-b border-ds-line/50 text-ds-ink cursor-pointer ${
                      rowIdx % 2 === 0 ? 'bg-background/40' : 'bg-ds-main/30'
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
                          r.industrialPriority
                            ? 'text-orange-400 fill-orange-400 drop-shadow-[0_0_8px_rgba(251,146,60,0.85)]'
                            : 'text-neutral-600'
                        }`}
                        strokeWidth={r.industrialPriority ? 0 : 1.5}
                      />
                    </td>
                    <td className="px-1.5 py-1 align-top">
                      <div className="font-medium text-ds-ink">
                        {qTrim ? spotlightHighlightText(r.boardType, qTrim) : r.boardType}
                      </div>
                      <div className="text-ds-ink-faint tabular-nums">
                        {r.gsm} gsm · {r.sheetSizeLabel} · {r.grainDirection}
                      </div>
                      <div className="text-ds-ink-faint tabular-nums">
                        {r.totalSheets.toLocaleString('en-IN')} sheets ·{' '}
                        {r.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 1 })} kg
                      </div>
                    </td>
                    <td className="px-1.5 py-1 align-top">
                      <div className={`space-y-0.5 ${ledgerMono}`}>
                        <SafetyStatusCell radar={r.reorderRadar} />
                        <div className="text-[8px] text-neutral-500 leading-tight">
                          net{' '}
                          <span className="text-ds-ink-muted">
                            {r.reorderRadar.netAvailable.toLocaleString('en-IN')}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-1.5 py-1 align-top">
                      <div className="flex flex-col gap-1 items-start">
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
                        {r.procurementHud.shortageAwaitingReplacement ? (
                          <span className="rounded border border-rose-500/35 bg-rose-500/20 px-1.5 py-0.5 text-[8px] font-bold text-rose-400">
                            Shortage: Awaiting
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-1.5 py-1 align-top">
                      <span
                        title={
                          r.cashFlowTerms.projectedPaymentYmd
                            ? `Projected payment ${r.cashFlowTerms.projectedPaymentYmd} (IST calendar)`
                            : r.cashFlowTerms.isProvisional
                              ? 'No GRN receipt yet — terms from supplier profile / suggestion'
                              : undefined
                        }
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[8px] font-bold font-mono tabular-nums whitespace-nowrap ${cashTermsBadgeClass(
                          r.cashFlowTerms.termsBand,
                        )}`}
                      >
                        {r.cashFlowTerms.badgeLabel}
                      </span>
                    </td>
                    <td className="px-1.5 py-1 align-top text-right">
                      {r.landedCost.basicRatePerKg != null ? (
                        <span className={`text-ds-ink-muted text-[10px] ${ledgerMono}`}>
                          ₹
                          {r.landedCost.basicRatePerKg.toLocaleString('en-IN', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="px-1.5 py-1 align-top text-right">
                      {r.landedCost.landedRatePerKg != null ? (
                        <div className="space-y-0.5">
                          <div
                            className={`text-[10px] font-semibold ${ledgerMono} ${STRATEGIC_SOURCING_GOLD}`}
                          >
                            ₹
                            {r.landedCost.landedRatePerKg.toLocaleString('en-IN', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 4,
                            })}
                          </div>
                          {r.landedCost.freightPctOfBasic != null &&
                          r.landedCost.freightPctOfBasic > 0 ? (
                            <div className={`text-[8px] text-neutral-500 ${ledgerMono}`}>
                              Freight: {r.landedCost.freightPctOfBasic.toFixed(1)}%
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="px-1.5 py-1 align-top whitespace-nowrap">
                      <span
                        className={`tabular-nums text-[11px] font-medium ${
                          ageCritical ? 'text-rose-400 animate-industrial-age-pulse' : 'text-ds-ink-muted'
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
                        <span className="text-neutral-600">—</span>
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
                        <span className="text-neutral-600 font-mono text-[9px]">—</span>
                      )}
                    </td>
                    <td className="px-1.5 py-1 align-top text-right tabular-nums font-semibold text-ds-warning">
                      {r.totalMetricTons.toLocaleString('en-IN', { maximumFractionDigits: 4 })}
                    </td>
                    <td
                      className="px-1.5 py-1 align-top text-ds-ink-muted font-mono text-[9px] cursor-help"
                      title={poHoverSummary(r)}
                    >
                      {linkedJobIdsDisplay(r)}
                    </td>
                    <td className="px-1.5 py-1 align-top text-ds-ink-muted">
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
        backdropClassName="bg-background/55"
        panelClassName="border-l border-ds-line/40 bg-background shadow-2xl"
      >
        {spotlightRow ? (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs text-ds-ink-muted">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold">Board spec</p>
              <p className="text-sm font-semibold text-ds-ink mt-0.5">
                {spotlightRow.boardType} · {spotlightRow.gsm} gsm
              </p>
              <p className="text-ds-ink-faint mt-0.5">
                {spotlightRow.sheetSizeLabel} · {spotlightRow.grainDirection}
              </p>
            </div>

            <div className="rounded-lg border border-ds-line/50 bg-background p-3 space-y-3 ring-1 ring-ring/5">
              <p className="text-[10px] uppercase tracking-wide text-ds-warning/90 font-semibold">
                Dynamic reorder radar
              </p>
              <div className={`grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-ds-ink-muted ${ledgerMono}`}>
                <span>Physical</span>
                <span className="text-right text-ds-ink">
                  {spotlightRow.reorderRadar.physicalSheets.toLocaleString('en-IN')} sh
                </span>
                <span>Allocated</span>
                <span className="text-right text-ds-ink">
                  {spotlightRow.reorderRadar.allocatedSheets.toLocaleString('en-IN')} sh
                </span>
                <span>Net</span>
                <span className="text-right text-ds-ink">
                  {spotlightRow.reorderRadar.netAvailable.toLocaleString('en-IN')} sh
                </span>
                <span>Status</span>
                <span className="text-right text-ds-warning">{spotlightRow.reorderRadar.stockStatus}</span>
                <span>Rec. qty</span>
                <span className="text-right text-emerald-200/90">
                  {spotlightRow.reorderRadar.recommendedReorderSheets.toLocaleString('en-IN')} sh
                </span>
              </div>
              <div className="space-y-2">
                <p className="text-[10px] text-neutral-500">Safety buffer (sheets)</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-[10px] text-neutral-500">
                    Min threshold
                    <input
                      type="number"
                      min={0}
                      value={policyMinInput}
                      onChange={(e) => setPolicyMinInput(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1 text-[11px] text-foreground ${ledgerMono}`}
                    />
                  </label>
                  <label className="block text-[10px] text-neutral-500">
                    Max buffer
                    <input
                      type="number"
                      min={0}
                      value={policyMaxInput}
                      onChange={(e) => setPolicyMaxInput(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1 text-[11px] text-foreground ${ledgerMono}`}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  disabled={policySaving}
                  onClick={() => void saveReorderPolicyFromSpotlight()}
                  className="w-full rounded-md border border-ds-line/50 bg-ds-main py-1.5 text-[11px] font-medium text-ds-ink hover:bg-ds-card disabled:opacity-50"
                >
                  {policySaving ? 'Saving…' : 'Save safety buffer'}
                </button>
              </div>
              {(spotlightRow.reorderRadar.isProcurementRisk ||
                spotlightRow.reorderRadar.safetyStatus !== 'healthy') && (
                <button
                  type="button"
                  disabled={draftReorderSubmitting}
                  onClick={() => void draftReorderPoFromSpotlight()}
                  className="w-full rounded-md border border-ds-warning/50 bg-ds-warning/10 py-2 text-[11px] font-semibold text-ds-warning hover:bg-ds-warning/10 disabled:opacity-50"
                >
                  {draftReorderSubmitting
                    ? 'Drafting…'
                    : 'Draft reorder PO (elite vendor · benchmark ₹/kg · rec. qty)'}
                </button>
              )}
            </div>

            {spotlightRow.procurementHud.primaryVendorPoId ? (
              <>
                <div className="rounded-lg border border-ds-line/50 bg-ds-main/55 p-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-wide text-cyan-500/90 font-semibold">
                    Digital waybill
                  </p>
                  <div className="space-y-2 text-[11px]">
                    <div className="flex justify-between gap-2 border-b border-ds-line/50 pb-2">
                      <span className="text-ds-ink-faint">Vendor (mill)</span>
                      <span className="text-ds-ink text-right font-medium">
                        {spotlightRow.procurementHud.primarySupplierName ?? '—'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2 border-b border-ds-line/50 pb-2">
                      <span className="text-ds-ink-faint">Transporter</span>
                      <span className="text-ds-ink text-right">{logisticsTransporter.trim() || '—'}</span>
                    </div>
                    <div className="flex justify-between gap-2 border-b border-ds-line/50 pb-2">
                      <span className="text-ds-ink-faint">LR / Docket</span>
                      <span
                        className={`text-ds-ink text-right tracking-tight ${industrialMono}`}
                      >
                        {logisticsLr.trim() || '—'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2 border-b border-ds-line/50 pb-2">
                      <span className="text-ds-ink-faint">Vehicle</span>
                      <span
                        className={`text-ds-ink text-right font-semibold tracking-wide ${industrialMono}`}
                      >
                        {logisticsVehicle.trim() || '—'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-ds-ink-faint">Target customer PO</span>
                      <span className="text-ds-ink-muted text-right font-mono text-[10px]">
                        {Array.from(new Set(spotlightRow.contributions.map((c) => c.poNumber))).join(' · ') ||
                          '—'}
                      </span>
                    </div>
                    <p className="text-[9px] text-neutral-600 pt-1">
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
                      <span className="text-[9px] text-neutral-500" title="Last logistics commit (server)">
                        Updated{' '}
                        {new Date(
                          spotlightRow.procurementHud.logistics.logisticsUpdatedAt,
                        ).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[10px] text-neutral-500 leading-snug">
                    Saving LR and vehicle promotes the load to{' '}
                    <strong className="text-sky-200">In-Transit</strong> automatically. When in-transit, the
                    lead buffer uses your estimated arrival vs production target. All writes are timestamped (
                    {PROCUREMENT_LOGISTICS_AUDIT_ACTOR}).
                  </p>
                  <label className="block text-[10px] text-ds-ink-faint">
                    Transporter
                    <input
                      list="ci-transporter-picks"
                      value={logisticsTransporter}
                      onChange={(e) => setLogisticsTransporter(e.target.value)}
                      className="mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1.5 text-ds-ink text-[11px]"
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
                  <label className="block text-[10px] text-ds-ink-faint">
                    LR number (docket ID)
                    <input
                      value={logisticsLr}
                      onChange={(e) => setLogisticsLr(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-ds-line/50 bg-ds-main px-2 py-1.5 text-ds-ink text-[11px] ${industrialMono}`}
                    />
                  </label>
                  <label className="block text-[10px] text-ds-ink-faint">
                    Vehicle number
                    <input
                      value={logisticsVehicle}
                      onChange={(e) => setLogisticsVehicle(e.target.value.toUpperCase())}
                      className={`mt-0.5 w-full rounded border border-ds-line/50 bg-ds-main px-2 py-1.5 text-ds-ink text-[12px] font-semibold ${industrialMono}`}
                    />
                  </label>
                  <label className="block text-[10px] text-ds-ink-faint">
                    Estimated arrival
                    <input
                      type="datetime-local"
                      value={logisticsEta}
                      onChange={(e) => setLogisticsEta(e.target.value)}
                      className="mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1.5 text-ds-ink text-[11px]"
                    />
                  </label>
                  <label className="block text-[10px] text-ds-ink-faint">
                    Logistics status
                    <select
                      value={logisticsStatusPick}
                      onChange={(e) =>
                        setLogisticsStatusPick(e.target.value as typeof logisticsStatusPick)
                      }
                      className="mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1.5 text-ds-ink text-[11px]"
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
                        className="w-full rounded-lg border border-ds-warning/55 bg-ds-warning/10 px-3 py-2 text-[11px] font-bold text-ds-ink hover:bg-ds-warning/10 disabled:opacity-50"
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
                            : 'Short-close requires ≥95% QC-passed usable kg vs ordered'
                        }
                        onClick={(e) => {
                          e.stopPropagation()
                          if (!spotlightRow.procurementHud.shortClose?.authorityGateMet) return
                          setShortCloseModalOpen(true)
                        }}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-ds-warning/45 bg-ds-warning/10 px-3 py-2 text-[11px] font-semibold text-ds-ink hover:bg-ds-warning/10 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <ListChecks className="h-3.5 w-3.5 opacity-90" aria-hidden />
                        Short-Close PO
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-lg border border-emerald-500/25 bg-background p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] uppercase tracking-wide text-emerald-400/90 font-semibold flex items-center gap-1.5">
                      <ClipboardList className="h-3.5 w-3.5 shrink-0 opacity-90" aria-hidden />
                      Goods Receipt Note (GRN) Ledger
                    </p>
                    {grnLoading ? (
                      <span className="text-[9px] text-neutral-600">Loading…</span>
                    ) : grnLedger ? (
                      <span className={`text-[9px] text-neutral-500 ${ledgerMono}`}>
                        {grnLedger.poNumber}
                      </span>
                    ) : null}
                  </div>
                  {spotlightRow.procurementHud.shortageAwaitingReplacement ? (
                    <div className="rounded border border-rose-500/35 bg-rose-500/10 px-2 py-1.5 text-[9px] font-bold text-rose-300">
                      Shortage: Awaiting replacement — lead buffer uses committed replacement ETA (
                      <span className={ledgerMono}>vs production target</span>).
                    </div>
                  ) : null}
                  <p className="text-[9px] text-neutral-600 leading-snug">
                    QC gate splits each truck into{' '}
                    <span className="text-emerald-400/90 font-semibold">standard</span>,{' '}
                    <span className="text-ds-warning font-semibold">penalty</span>, and{' '}
                    <span className="text-rose-400/90 font-semibold">return</span> (must sum to gross kg). Usable =
                    standard + penalty. Payable accrual uses full rate on standard and adjusted rate on penalty. Mono
                    alignment for quantities. Signed {PROCUREMENT_LOGISTICS_AUDIT_ACTOR} lane.
                  </p>
                  {grnLedger ? (
                    <>
                      <div className="overflow-x-auto rounded border border-ds-line/30 bg-background">
                        <table className="w-full text-left text-[9px] text-ds-ink-muted border-collapse">
                          <thead>
                            <tr className="border-b border-ds-line/40 bg-background text-[8px] uppercase tracking-wide text-neutral-600">
                              <th className="px-1.5 py-1 font-semibold">Date</th>
                              <th className="px-1.5 py-1 font-semibold text-right">Qty (kg)</th>
                              <th className="px-1.5 py-1 font-semibold">Vehicle</th>
                              <th className="px-1.5 py-1 font-semibold">Slip</th>
                              <th className="px-1.5 py-1 font-semibold">GSM</th>
                              <th className="px-1.5 py-1 font-semibold">QC</th>
                              <th className="px-1.5 py-1 font-semibold">By</th>
                            </tr>
                          </thead>
                          <tbody>
                            {grnLedger.receipts.length === 0 ? (
                              <tr>
                                <td colSpan={7} className="px-1.5 py-3 text-center text-neutral-600">
                                  No receipts yet — log the first GRN below.
                                </td>
                              </tr>
                            ) : (
                              grnLedger.receipts.map((rec) => {
                                const ordGsm = grnLedger.orderedGsm ?? spotlightRow.gsm
                                const actGsm = rec.qcDetails?.actualGsm
                                const gsmLabel =
                                  actGsm != null && Number.isFinite(actGsm)
                                    ? `${actGsm} / ${ordGsm}`
                                    : `— / ${ordGsm}`
                                const failed = rec.qcStatus === 'FAILED'
                                const hasSplit =
                                  rec.qtyAcceptedStandard != null &&
                                  rec.qtyAcceptedPenalty != null &&
                                  rec.qtyRejected != null
                                return (
                                  <tr
                                    key={rec.id}
                                    className={`border-b border-ds-line/30 ${failed ? 'bg-rose-950/40' : ''}`}
                                  >
                                    <td className="px-1.5 py-1 whitespace-nowrap text-ds-ink-faint">
                                      {new Date(rec.receiptDate).toLocaleString('en-IN', {
                                        timeZone: 'Asia/Kolkata',
                                        day: '2-digit',
                                        month: 'short',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })}
                                    </td>
                                    <td
                                      className={`px-1.5 py-1 text-right text-emerald-400/95 font-semibold ${ledgerMono}`}
                                    >
                                      {rec.receivedQty.toLocaleString('en-IN', { maximumFractionDigits: 3 })}
                                    </td>
                                    <td className={`px-1.5 py-1 text-ds-ink-muted ${ledgerMono}`}>
                                      {rec.vehicleNumber}
                                    </td>
                                    <td className={`px-1.5 py-1 text-ds-ink-muted ${ledgerMono}`}>
                                      {rec.scaleSlipId}
                                    </td>
                                    <td className={`px-1.5 py-1 text-ds-ink-muted ${ledgerMono}`}>{gsmLabel}</td>
                                    <td className="px-1.5 py-1 align-top">
                                      {!rec.qcComplete ? (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            setGrnQcReceiptId(rec.id)
                                            setGrnQcActualGsm(
                                              ordGsm != null && Number.isFinite(ordGsm) ? String(ordGsm) : '',
                                            )
                                            setGrnQcShadeMatch(true)
                                            setGrnQcSurfaceClean(true)
                                            setGrnQcRemarks('')
                                            setGrnQcQtyStandard(String(rec.receivedQty))
                                            setGrnQcQtyPenalty('0')
                                            setGrnQcQtyRejected('0')
                                            setGrnQcRejectionReason(GRN_REJECTION_REASONS[0] ?? '')
                                            setGrnQcRejectionRemarks('')
                                          }}
                                          className="rounded border border-ds-warning/30 bg-ds-warning/8 px-1.5 py-0.5 text-[8px] font-bold text-ds-ink hover:bg-ds-warning/30"
                                        >
                                          Perform QC
                                        </button>
                                      ) : rec.qcStatus === 'PASSED_WITH_PENALTY' ? (
                                        <span className="flex flex-col gap-0.5 items-start">
                                          <span className="inline-flex rounded border border-emerald-500/55 bg-emerald-950/45 px-1.5 py-0.5 text-[8px] font-bold text-emerald-200">
                                            QC passed
                                          </span>
                                          <span className="inline-flex items-center gap-0.5 rounded border border-ds-warning/50 bg-ds-warning/15 px-1.5 py-0.5 text-[8px] font-bold text-ds-warning">
                                            <IndianRupee className="h-2.5 w-2.5 shrink-0 opacity-90" aria-hidden />
                                            Quality-adjusted
                                          </span>
                                          {hasSplit ? (
                                            <span
                                              className={`text-[7px] leading-tight ${ledgerMono} text-neutral-500 max-w-[5.5rem]`}
                                            >
                                              <span className="text-emerald-400/95">{rec.qtyAcceptedStandard}</span> /{' '}
                                              <span className="text-ds-warning/95">{rec.qtyAcceptedPenalty}</span> /{' '}
                                              <span className="text-rose-400/95">{rec.qtyRejected}</span>
                                            </span>
                                          ) : null}
                                        </span>
                                      ) : rec.qcStatus === 'PASSED' ? (
                                        <span className="flex flex-col gap-0.5 items-start">
                                          <span className="inline-flex rounded border border-emerald-500/55 bg-emerald-950/45 px-1.5 py-0.5 text-[8px] font-bold text-emerald-200">
                                            QC passed
                                          </span>
                                          {hasSplit && (rec.qtyRejected ?? 0) > 0 ? (
                                            <span
                                              className={`text-[7px] leading-tight ${ledgerMono} text-neutral-500 max-w-[5.5rem]`}
                                            >
                                              <span className="text-emerald-400/95">{rec.qtyAcceptedStandard}</span> /{' '}
                                              <span className="text-ds-warning/95">{rec.qtyAcceptedPenalty}</span> /{' '}
                                              <span className="text-rose-400/95">{rec.qtyRejected}</span>
                                            </span>
                                          ) : null}
                                        </span>
                                      ) : (
                                        <span className="inline-flex rounded border border-rose-500/55 bg-rose-950/45 px-1.5 py-0.5 text-[8px] font-bold text-rose-200">
                                          Rejected
                                        </span>
                                      )}
                                      {rec.qcComplete && (rec.qtyRejected ?? 0) > 0 ? (
                                        <button
                                          type="button"
                                          disabled={returnPassWorkingId === rec.id}
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            void generateReturnGatePass(rec.id)
                                          }}
                                          className="mt-1 w-full rounded border border-rose-500/45 bg-rose-950/30 px-1 py-0.5 text-[7px] font-bold text-rose-100 hover:bg-rose-950/45 disabled:opacity-50"
                                        >
                                          {returnPassWorkingId === rec.id ? '…' : 'Return gate pass'}
                                        </button>
                                      ) : null}
                                    </td>
                                    <td className="px-1.5 py-1 text-ds-ink-faint truncate max-w-[3.5rem]">
                                      {rec.receivedByName}
                                    </td>
                                  </tr>
                                )
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                      {grnQcReceiptId ? (
                        <div
                          className={`space-y-2 rounded-lg border ${STRATEGIC_SOURCING_GOLD_BORDER} bg-background p-2.5 ring-1 ring-ds-warning/35`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <p className={`text-[10px] font-bold ${STRATEGIC_SOURCING_GOLD}`}>QC gate — split tranches</p>
                          <p className="text-[8px] text-neutral-600">
                            Enter standard (stock), penalty (GSM shortfall bucket), and rejected (return) kg. Sum must
                            equal gate weight. Penalty tranche requires actual GSM &lt; ordered. &gt;5% GSM deviation
                            alerts {PROCUREMENT_LOGISTICS_AUDIT_ACTOR}.
                          </p>
                          <div className="grid grid-cols-3 gap-1.5">
                            <label className="block text-[8px] text-emerald-400/90 font-bold">
                              Standard (kg)
                              <input
                                type="number"
                                step="any"
                                min={0}
                                value={grnQcQtyStandard}
                                onChange={(e) => setGrnQcQtyStandard(e.target.value)}
                                className={`mt-0.5 w-full rounded border border-emerald-500/45 bg-background px-1.5 py-1 text-emerald-100 text-[11px] ${ledgerMono}`}
                              />
                            </label>
                            <label className="block text-[8px] text-ds-warning font-bold">
                              Penalty (kg)
                              <input
                                type="number"
                                step="any"
                                min={0}
                                value={grnQcQtyPenalty}
                                onChange={(e) => setGrnQcQtyPenalty(e.target.value)}
                                className={`mt-0.5 w-full rounded border border-ds-warning/45 bg-background px-1.5 py-1 text-ds-ink text-[11px] ${ledgerMono}`}
                              />
                            </label>
                            <label className="block text-[8px] text-rose-400/90 font-bold">
                              Return (kg)
                              <input
                                type="number"
                                step="any"
                                min={0}
                                value={grnQcQtyRejected}
                                onChange={(e) => setGrnQcQtyRejected(e.target.value)}
                                className={`mt-0.5 w-full rounded border border-rose-500/45 bg-background px-1.5 py-1 text-rose-100 text-[11px] ${ledgerMono}`}
                              />
                            </label>
                          </div>
                          {Number(grnQcQtyRejected) > 0 ? (
                            <div className="space-y-1.5 rounded border border-rose-500/25 bg-background p-2">
                              <p className="text-[8px] font-bold text-rose-300/95 uppercase tracking-wide">
                                Rejection — Anik Dua signature lane
                              </p>
                              <label className="block text-[8px] text-neutral-500">
                                Reason
                                <select
                                  value={grnQcRejectionReason}
                                  onChange={(e) => setGrnQcRejectionReason(e.target.value)}
                                  className="mt-0.5 w-full rounded border border-ds-line/40 bg-ds-main px-2 py-1 text-[10px] text-ds-ink"
                                >
                                  {GRN_REJECTION_REASONS.map((r) => (
                                    <option key={r} value={r}>
                                      {r}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="block text-[8px] text-neutral-500">
                                Remarks <span className="text-rose-500/80">(required)</span>
                                <textarea
                                  value={grnQcRejectionRemarks}
                                  onChange={(e) => setGrnQcRejectionRemarks(e.target.value)}
                                  rows={2}
                                  className="mt-0.5 w-full rounded border border-ds-line/40 bg-background px-2 py-1 text-[10px] text-ds-ink"
                                  placeholder="Document rejection for audit…"
                                />
                              </label>
                            </div>
                          ) : null}
                          <label className="block text-[9px] text-neutral-500">
                            Actual GSM
                            <input
                              type="number"
                              step="any"
                              value={grnQcActualGsm}
                              onChange={(e) => setGrnQcActualGsm(e.target.value)}
                              className={`mt-0.5 w-full rounded border border-ds-line/40 bg-ds-main px-2 py-1 text-ds-ink text-[11px] ${ledgerMono}`}
                            />
                          </label>
                          <label className="flex items-center gap-2 text-[9px] text-ds-ink-muted">
                            <input
                              type="checkbox"
                              checked={grnQcShadeMatch}
                              onChange={(e) => setGrnQcShadeMatch(e.target.checked)}
                              className="rounded border-ds-line/50"
                            />
                            Shade match
                          </label>
                          <label className="flex items-center gap-2 text-[9px] text-ds-ink-muted">
                            <input
                              type="checkbox"
                              checked={grnQcSurfaceClean}
                              onChange={(e) => setGrnQcSurfaceClean(e.target.checked)}
                              className="rounded border-ds-line/50"
                            />
                            Surface cleanliness
                          </label>
                          <label className="block text-[9px] text-neutral-500">
                            QC remarks
                            <textarea
                              value={grnQcRemarks}
                              onChange={(e) => setGrnQcRemarks(e.target.value)}
                              rows={2}
                              className="mt-0.5 w-full rounded border border-ds-line/40 bg-background px-2 py-1 text-[10px] text-ds-ink"
                            />
                          </label>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={grnQcSaving}
                              onClick={() => void submitGrnQcSplit()}
                              className="flex-1 rounded-md border border-ds-warning/50 bg-ds-warning/10 py-1.5 text-[10px] font-bold text-ds-ink hover:bg-ds-warning/10 disabled:opacity-50"
                            >
                              {grnQcSaving ? '…' : 'Submit QC gate'}
                            </button>
                            <button
                              type="button"
                              disabled={grnQcSaving}
                              onClick={() => setGrnQcReceiptId(null)}
                              className="rounded-md border border-ds-line/50 bg-background px-2 py-1.5 text-[10px] text-neutral-500"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {grnLedger.receipts.some(
                        (r) => r.qcStatus === 'PASSED_WITH_PENALTY' && r.penaltyProofLines?.length,
                      ) ? (
                        <div className="rounded-lg border border-ds-line/40 bg-background p-2 space-y-2">
                          <p className="text-[9px] uppercase tracking-wide text-ds-warning/90 font-bold">
                            Vendor-facing penalty proof (export / email)
                          </p>
                          {grnLedger.receipts
                            .filter((r) => r.qcStatus === 'PASSED_WITH_PENALTY' && r.penaltyProofLines?.length)
                            .map((r) => (
                              <pre
                                key={r.id}
                                className={`whitespace-pre-wrap rounded border border-ds-line/30 bg-ds-main/80 p-2 text-[9px] text-ds-ink-muted leading-relaxed ${ledgerMono}`}
                              >
                                {`Slip ${r.scaleSlipId} · vehicle ${r.vehicleNumber}\n${(r.penaltyProofLines ?? []).join('\n')}${r.qualityDebitNote ? `\n\nLedger: ${r.qualityDebitNote.status.replace(/_/g, ' ')}` : ''}`}
                              </pre>
                            ))}
                        </div>
                      ) : null}
                      <div className="rounded border border-ds-line/40 bg-background px-2 py-2 space-y-1.5">
                        <p className="text-[8px] uppercase tracking-wide text-neutral-600 font-bold">Summary</p>
                        <p
                          className={`text-[9px] text-neutral-500 leading-snug ${ledgerMono}`}
                          title="Aggregated from completed QC rows (legacy rows: full truck counted as stock or return)"
                        >
                          Receipt breakdown:{' '}
                          <span className="text-emerald-400/95">
                            Stock {(grnLedger.receiptBreakdownStockKg ?? 0).toLocaleString('en-IN', {
                              maximumFractionDigits: 3,
                            })}
                            kg
                          </span>{' '}
                          <span className="text-neutral-600">|</span>{' '}
                          <span className="text-ds-warning/95">
                            Penalty {(grnLedger.receiptBreakdownPenaltyKg ?? 0).toLocaleString('en-IN', {
                              maximumFractionDigits: 3,
                            })}
                            kg
                          </span>{' '}
                          <span className="text-neutral-600">|</span>{' '}
                          <span className="text-rose-400/95">
                            Return {(grnLedger.receiptBreakdownReturnKg ?? 0).toLocaleString('en-IN', {
                              maximumFractionDigits: 3,
                            })}
                            kg
                          </span>
                        </p>
                        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[10px]">
                          <span className="text-neutral-500">
                            Total ordered{' '}
                            <span className={`text-ds-ink ${ledgerMono}`}>
                              {grnLedger.orderedKg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg
                            </span>
                          </span>
                          <span className="text-neutral-500">
                            Usable (QC passed){' '}
                            <span className={`text-emerald-400 font-semibold ${ledgerMono}`}>
                              {(grnLedger.totalUsableReceivedKg ?? 0).toLocaleString('en-IN', {
                                maximumFractionDigits: 3,
                              })}{' '}
                              kg
                            </span>
                          </span>
                          <span className="text-neutral-500">
                            At gate (gross){' '}
                            <span className={`text-ds-ink-muted ${ledgerMono}`}>
                              {grnLedger.totalReceivedKg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg
                            </span>
                          </span>
                          <span className="text-neutral-500">
                            Outstanding (prod.){' '}
                            <span className={`text-ds-warning font-semibold ${ledgerMono}`}>
                              {grnLedger.outstandingKg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg
                            </span>
                          </span>
                          <span className="text-neutral-500">
                            Total payable (accrued){' '}
                            <span className={`text-ds-warning font-semibold ${ledgerMono}`}>
                              {formatRupee(grnLedger.accruedReceiptPayableInr ?? 0)}
                            </span>
                          </span>
                        </div>
                        <p className="text-[8px] text-neutral-600">
                          PO status:{' '}
                          <span className="text-ds-ink-muted font-medium">{grnLedger.status.replace(/_/g, ' ')}</span>
                        </p>
                      </div>
                      {['dispatched', 'partially_received', 'fully_received'].includes(grnLedger.status) ? (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setGrnExpanded((v) => !v)
                              if (!grnReceiptDate) {
                                const d = new Date()
                                const pad = (n: number) => String(n).padStart(2, '0')
                                setGrnReceiptDate(
                                  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
                                )
                              }
                            }}
                            className="w-full rounded-md border border-emerald-500/40 bg-emerald-950/20 py-1.5 text-[10px] font-bold text-emerald-200/95 hover:bg-emerald-950/35"
                          >
                            {grnExpanded ? 'Hide add receipt' : '+ Add receipt'}
                          </button>
                          {grnExpanded ? (
                            <div
                              className="space-y-2 rounded border border-ds-line/40 bg-ds-main/40 p-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <label className="block text-[9px] text-neutral-500">
                                Receipt date / time
                                <input
                                  type="datetime-local"
                                  value={grnReceiptDate}
                                  onChange={(e) => setGrnReceiptDate(e.target.value)}
                                  className={`mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1 text-ds-ink text-[11px] ${ledgerMono}`}
                                />
                              </label>
                              <label className="block text-[9px] text-neutral-500">
                                Received qty (kg)
                                <input
                                  type="number"
                                  step="any"
                                  min={0}
                                  value={grnReceivedQty}
                                  onChange={(e) => setGrnReceivedQty(e.target.value)}
                                  className={`mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1 text-emerald-200 text-[11px] font-semibold ${ledgerMono}`}
                                />
                              </label>
                              <label className="block text-[9px] text-neutral-500">
                                Vehicle number
                                <input
                                  value={grnVehicle}
                                  onChange={(e) => setGrnVehicle(e.target.value.toUpperCase())}
                                  className={`mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1 text-ds-ink text-[11px] ${ledgerMono}`}
                                />
                              </label>
                              <label className="block text-[9px] text-neutral-500">
                                Scale slip ID
                                <input
                                  value={grnScaleSlip}
                                  onChange={(e) => setGrnScaleSlip(e.target.value)}
                                  className={`mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1 text-ds-ink text-[11px] ${ledgerMono}`}
                                />
                              </label>
                              <button
                                type="button"
                                disabled={grnSaving}
                                onClick={() => void submitGrnReceipt()}
                                className="w-full rounded-md border border-emerald-500/50 bg-emerald-950/35 py-2 text-[10px] font-bold text-emerald-100 hover:bg-emerald-950/50 disabled:opacity-50"
                              >
                                {grnSaving ? 'Saving…' : 'Log receipt (timestamped)'}
                              </button>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <p className="text-[9px] text-neutral-600">Receipts are closed for this PO.</p>
                      )}
                    </>
                  ) : !grnLoading ? (
                    <p className="text-[9px] text-neutral-600">Could not load GRN ledger.</p>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="text-[11px] text-neutral-600">
                Logistics HUD unlocks after the vendor PO is{' '}
                <span className="text-ds-ink-muted">dispatched</span> from the mill.
              </p>
            )}

            {spotlightRow.leadBuffer ? (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold mb-1">
                  Lead-time buffer (factory IST)
                </p>
                <div
                  className={`rounded-lg border p-2.5 space-y-2 ${
                    spotlightRow.leadBuffer.level === 'critical'
                      ? 'border-rose-500/50 bg-rose-950/25'
                      : spotlightRow.leadBuffer.level === 'at_risk'
                        ? 'border-ds-warning/45 bg-ds-warning/8'
                        : 'border-ds-line/50 bg-ds-main/40'
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
                    <span className="text-sm font-bold tabular-nums text-ds-ink">
                      {spotlightRow.leadBuffer.badgeLabel}
                    </span>
                  </div>
                  <p className="text-[11px] text-ds-ink-faint leading-relaxed">
                    Vendor ETA{' '}
                    <span className="text-ds-ink-muted font-mono">{spotlightRow.leadBuffer.vendorEtaYmd}</span>
                    {spotlightRow.procurementHud.variant === 'in_transit' ||
                    spotlightRow.procurementHud.variant === 'in_transit_stale' ? (
                      <span className="text-neutral-600"> (from estimated arrival when in-transit)</span>
                    ) : null}
                    {' · '}
                    Production target{' '}
                    <span className="text-ds-ink-muted font-mono">{spotlightRow.leadBuffer.productionTargetYmd}</span>
                    {' · '}
                    <span className="text-ds-ink-muted">{spotlightRow.leadBuffer.vendorPoNumber}</span>
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
              <p className="text-[11px] text-neutral-600">
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
                  <p className="text-[11px] text-ds-ink-faint">Loading strategic scorecard…</p>
                ) : scorecardDetail ? (
                  <>
                    <p className="text-[11px] text-ds-ink-muted">
                      <span className="text-ds-ink-faint">Supplier:</span>{' '}
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
                    <p className="text-[9px] text-neutral-500">
                      Monthly delivery accuracy (last 6 months) · dispatch vs required date
                    </p>
                    <div className="grid grid-cols-1 gap-2 text-[11px]">
                      <div
                        className={`rounded-md border px-2.5 py-2 ${STRATEGIC_SOURCING_GOLD_BORDER} bg-background/40`}
                      >
                        <p className="text-neutral-500 text-[9px] uppercase tracking-wide font-semibold">
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
                        className={`rounded-md border px-2.5 py-2 ${STRATEGIC_SOURCING_GOLD_BORDER} bg-background/40`}
                      >
                        <p className="text-neutral-500 text-[9px] uppercase tracking-wide font-semibold">
                          Average lead time
                        </p>
                        <p className={`mt-0.5 font-bold tabular-nums ${STRATEGIC_SOURCING_GOLD}`}>
                          {scorecardDetail.avgLeadTimeDays != null
                            ? `${scorecardDetail.avgLeadTimeDays.toLocaleString('en-IN')} days`
                            : '—'}
                          <span className="text-neutral-600 font-normal text-[10px]">
                            {' '}
                            (dispatch → reconciliation)
                          </span>
                        </p>
                      </div>
                    </div>
                    <p className="text-[9px] text-neutral-600 leading-snug">
                      Snapshot: delivery {scorecardDetail.snapshot.deliveryScore} · weight{' '}
                      {scorecardDetail.snapshot.weightScore} · composite{' '}
                      {scorecardDetail.snapshot.compositeScore}{' '}
                      <span className="font-mono">({scorecardDetail.snapshot.otifCount}/
                      {scorecardDetail.snapshot.totalDeliveryOrders} OTIF dispatches)</span>
                    </p>
                  </>
                ) : (
                  <p className="text-[11px] text-neutral-600">Scorecard unavailable for this supplier.</p>
                )}
              </div>
            ) : null}

            {spotlightRow.contributions.some((c) => c.materialProcurementStatus === 'received') ? (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold mb-1">
                  Material receipt (weights)
                </p>
                <p className="text-[10px] text-neutral-600 mb-2 leading-snug">
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
                          className="rounded-lg border border-ds-line/40 bg-ds-main/40 p-2.5 space-y-2"
                        >
                          <p className="text-[11px] text-ds-ink font-medium">
                            {c.poNumber} · {c.cartonName}
                          </p>
                          <div className="grid grid-cols-2 gap-2 text-[10px]">
                            <label className="text-ds-ink-faint">
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
                                className="mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1 font-mono text-ds-ink text-[11px]"
                              />
                            </label>
                            <label className="text-ds-ink-faint">
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
                                className="mt-0.5 w-full rounded border border-ds-line/50 bg-background px-2 py-1 font-mono text-ds-ink text-[11px]"
                              />
                            </label>
                          </div>
                          <div className="font-mono text-[10px] text-ds-ink-muted space-y-0.5 tabular-nums">
                            <p>
                              Invoice (kg):{' '}
                              <span className="text-ds-ink">
                                {inv != null && inv > 0 ? inv.toFixed(3) : '—'}
                              </span>
                              {!rec ? (
                                <span className="text-neutral-600"> (planned · confirm on save)</span>
                              ) : null}
                            </p>
                            <p>
                              Net received (kg):{' '}
                              <span className="text-ds-ink">
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
                                      ? 'text-ds-warning'
                                      : 'text-ds-ink'
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
                            <p className="text-[10px] font-semibold text-ds-warning/90">
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
                            className="w-full rounded-md border border-ds-line/50 bg-ds-card py-1.5 text-[10px] font-semibold text-ds-ink hover:bg-ds-elevated disabled:opacity-50"
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
                              <pre className="whitespace-pre-wrap rounded border border-ds-line/40 bg-background p-2 text-[10px] font-mono text-ds-ink-muted leading-relaxed">
                                {rec.debitNoteDraftText}
                              </pre>
                              <p className="text-[9px] text-neutral-500 mt-1 leading-snug">{DEBIT_NOTE_DRAFT_SIGNATURE}</p>
                            </div>
                          ) : null}
                        </li>
                      )
                    })}
                </ul>
              </div>
            ) : null}

            <div>
              <p className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold mb-1">
                Price audit (30d benchmark)
              </p>
              {priceIntelLoading ? (
                <p className="text-ds-ink-faint text-[11px]">Loading…</p>
              ) : priceIntel?.benchmark30d ? (
                <div className="space-y-2 rounded-lg border border-ds-line/40 bg-ds-main/50 p-2">
                  <div className="flex flex-wrap items-center gap-2 justify-between">
                    <p className="text-[11px] text-ds-ink-muted leading-snug min-w-0 flex-1">
                      Market best (30d):{' '}
                      <span className="font-mono text-ds-warning tabular-nums">
                        ₹
                        {priceIntel.benchmark30d.ratePerKg.toLocaleString('en-IN', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                        /kg
                      </span>
                      <span className="text-neutral-500"> · {priceIntel.benchmark30d.supplierName}</span>
                    </p>
                    <PriceTrendSparkline
                      data={priceIntel.trend6m}
                      tooltip={priceIntel.trendTooltip}
                    />
                  </div>
                  {(() => {
                    const cur = grnLedger?.invoiceRatePerKg
                    const b = priceIntel.benchmark30d
                    if (cur == null || !Number.isFinite(cur) || cur <= 0 || !b) return null
                    const v = computePriceVariancePct(cur, b.ratePerKg)
                    if (v <= PRICE_BENCHMARK_WARN_THRESHOLD_PCT) return null
                    const kgBase = grnLedger?.orderedKg ?? spotlightRow.totalWeightKg
                    const amt =
                      Number.isFinite(kgBase) && kgBase > 0
                        ? Math.round((cur - b.ratePerKg) * kgBase * 100) / 100
                        : null
                    return (
                      <div className="rounded-md bg-rose-500/10 px-2 py-1.5 text-[10px] text-rose-500 leading-snug">
                        <p>
                          Rate is {v.toFixed(1)}% above market best (₹{b.ratePerKg.toFixed(2)} from{' '}
                          {b.supplierName}).
                        </p>
                        {amt != null && amt > 0 ? (
                          <p className="mt-0.5 font-mono tabular-nums text-rose-500">
                            Potential Saving: ₹
                            {amt.toLocaleString('en-IN', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                            .
                          </p>
                        ) : null}
                      </div>
                    )
                  })()}
                </div>
              ) : (
                <p className="text-[11px] text-ds-ink-faint">No 30-day benchmark yet for this grade.</p>
              )}
            </div>

            <div className="rounded-lg border border-ds-line/40 bg-background p-3 space-y-2">
              <p className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold">
                Financial impact
              </p>
              {(() => {
                const cf = spotlightRow.cashFlowTerms
                const proj = cf.projectedPaymentYmd
                const fmt = proj
                  ? new Date(`${proj}T12:00:00.000Z`).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })
                  : null
                const amt = cf.accruedPayableInr
                const days = cf.paymentTermsDays
                return (
                  <>
                    <p className="text-[11px] text-ds-ink">
                      Payment Due:{' '}
                      <span className="font-mono tabular-nums text-ds-warning">
                        {fmt ?? '—'}
                      </span>
                      {cf.isProvisional ? (
                        <span className="text-neutral-500 text-[10px]"> (no GRN receipt date yet)</span>
                      ) : null}
                    </p>
                    {amt != null && amt > 0 ? (
                      <p className="text-[11px] text-ds-ink-muted">
                        <span className="font-mono tabular-nums">
                          Working Capital Impact: ₹
                          {amt.toLocaleString('en-IN', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}{' '}
                          held for {days} days.
                        </span>
                      </p>
                    ) : (
                      <p className="text-[11px] text-ds-ink-faint font-mono tabular-nums">
                        Working Capital Impact: — (no accrued payable on file)
                      </p>
                    )}
                    {cf.alternativeBetterTerms ? (
                      <p className="text-[10px] text-sky-200/90 leading-snug border-t border-ds-line/50 pt-2 mt-1">
                        Alternative: {cf.alternativeBetterTerms.supplierName} offers{' '}
                        <span className="font-mono tabular-nums">
                          {cf.alternativeBetterTerms.extraDays}
                        </span>{' '}
                        days extra credit.
                      </p>
                    ) : null}
                  </>
                )
              })()}
            </div>

            <ProcurementLandedCostPanel
              key={spotlightRow.key}
              landedCost={spotlightRow.landedCost}
              primaryVendorPoNumber={spotlightRow.procurementHud.primaryVendorPoNumber}
              requirementKey={spotlightRow.key}
              debouncedQ={debouncedQ}
              riskFilterHigh={riskFilterHigh}
              vendorRiskFilterHigh={vendorRiskFilterHigh}
              stockOutRiskFilterHigh={stockOutRiskFilterHigh}
              loadRequirements={loadRequirements}
              setSpotlightRow={setSpotlightRow}
            />

            <div>
              <p className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold mb-1">
                Price history (last purchases)
              </p>
              {priceIntelLoading ? (
                <p className="text-ds-ink-faint">Loading…</p>
              ) : priceIntel && priceIntel.history.length > 0 ? (
                <ul className="space-y-1.5 rounded-lg border border-ds-line/40 bg-ds-main/50 p-2">
                  {priceIntel.history.map((h, i) => (
                    <li key={`${h.poNumber}-${i}`} className="flex justify-between gap-2 text-[11px]">
                      <span className="text-ds-ink-muted">
                        {h.dispatchedAt ? new Date(h.dispatchedAt).toLocaleDateString('en-IN') : '—'}
                      </span>
                      <span className="text-ds-ink font-mono">
                        {h.ratePerKg != null ? `₹${h.ratePerKg.toFixed(2)}/kg` : '—'}
                      </span>
                      <span className="text-ds-ink-faint truncate max-w-[120px]" title={h.supplierName}>
                        {h.supplierName}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ds-ink-faint">No dispatched rates for this GSM yet.</p>
              )}
              {priceIntel?.lastPurchaseRate != null && priceIntel.lastPurchaseRate > 0 ? (
                <p className="text-[11px] text-ds-ink-faint mt-1.5">
                  Benchmark last rate:{' '}
                  <span className="text-ds-warning font-mono tabular-nums">
                    ₹{priceIntel.lastPurchaseRate.toFixed(2)}/kg
                  </span>
                </p>
              ) : null}
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold mb-1">
                Linked demand (customer POs)
              </p>
              <ul className="max-h-48 overflow-y-auto space-y-1.5 rounded-lg border border-ds-line/40 bg-ds-main/50 p-2">
                {spotlightRow.contributions.map((c) => (
                  <li key={c.poLineItemId} className="text-[11px] leading-snug border-b border-ds-line/50 pb-1.5 last:border-0">
                    <span className="font-mono text-ds-warning/80">{c.poNumber}</span>
                    <span className="text-neutral-600"> · </span>
                    {qTrim ? spotlightHighlightText(c.cartonName, qTrim) : c.cartonName}
                    <span className="text-neutral-500 block mt-0.5">
                      {c.customerName} · {c.materialProcurementStatus.replace(/_/g, ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-wide text-ds-ink-faint font-semibold mb-1">
                Vendor performance
              </p>
              {spotlightRow.suggestedSupplierName ? (
                <p className="text-[11px] text-ds-ink-muted mb-1">{spotlightRow.suggestedSupplierName}</p>
              ) : null}
              {supplierPerf && supplierPerf.sampleSize > 0 ? (
                <p className="text-[11px] text-ds-ink">
                  Avg. days late (dispatch vs required):{' '}
                  <span className="font-semibold tabular-nums text-ds-warning">
                    {supplierPerf.avgDaysLate?.toFixed(1) ?? '—'}
                  </span>
                  <span className="text-ds-ink-faint"> · n={supplierPerf.sampleSize}</span>
                </p>
              ) : (
                <p className="text-ds-ink-faint text-[11px]">No benchmark dispatches for this supplier yet.</p>
              )}
            </div>
          </div>
        ) : null}
      </SlideOverPanel>

      {draft || draftLoading ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Vendor PO draft"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-ds-line/60 bg-ds-main p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-2 mb-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {draft?.dispatchedAt ? 'Vendor PO (dispatched)' : 'Vendor PO draft'}
                </h2>
                {draft ? (
                  <p className="text-[11px] text-ds-ink-faint mt-0.5">
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
                className="rounded p-1 text-ds-ink-muted hover:bg-ds-elevated hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {draftLoading || !draft ? (
              <p className="text-ds-ink-faint text-xs">Loading…</p>
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
                    <label className="text-[10px] text-ds-ink-faint">Required delivery</label>
                    <p className="text-ds-ink">
                      {draft.requiredDeliveryDate
                        ? String(draft.requiredDeliveryDate).slice(0, 10)
                        : '— (set customer delivery on PO)'}
                    </p>
                  </div>
                  <div>
                    <label className="text-[10px] text-ds-ink-faint">Signatory</label>
                    <input
                      value={draft.signatoryName}
                      onChange={(e) => setDraft({ ...draft, signatoryName: e.target.value })}
                      disabled={!!draft.dispatchedAt}
                      className="mt-0.5 w-full rounded border border-ds-line/60 bg-ds-card px-2 py-1 text-foreground disabled:opacity-50"
                    />
                  </div>
                </div>
                {lastPurchaseBenchmark != null && lastPurchaseBenchmark > 0 ? (
                  <p className="text-[10px] text-ds-ink-faint">
                    First-line benchmark (30d or last dispatch):{' '}
                    <span className="text-ds-warning font-mono tabular-nums">
                      ₹{lastPurchaseBenchmark.toFixed(2)}/kg
                    </span>
                    {' — '}per-line rates use 30d market low when loaded; {'>'}2% vs benchmark highlights in rose.
                  </p>
                ) : null}
                <ul className="space-y-2 border border-ds-line/40 rounded-md p-2">
                  {draft.lines.map((ln) => {
                    const lineKey = `${ln.boardGrade}|${ln.gsm}`
                    const intelLine = benchByLineKey[lineKey] ?? emptyPriceIntelBundle()
                    const bench = intelLine.benchmark30d
                    const benchRate = bench?.ratePerKg ?? null
                    const raw = lineRates[ln.id] ?? ''
                    const num = raw === '' ? NaN : Number(raw)
                    let hot = false
                    if (benchRate != null && benchRate > 0 && Number.isFinite(num)) {
                      hot = num > benchRate * (1 + PRICE_BENCHMARK_WARN_THRESHOLD_PCT / 100)
                    } else if (
                      lastPurchaseBenchmark != null &&
                      lastPurchaseBenchmark > 0 &&
                      Number.isFinite(num)
                    ) {
                      hot = num > lastPurchaseBenchmark * 1.05
                    }
                    const varPct =
                      bench &&
                      Number.isFinite(num) &&
                      num > 0 &&
                      bench.ratePerKg > 0
                        ? computePriceVariancePct(num, bench.ratePerKg)
                        : null
                    const showWarn =
                      varPct != null && varPct > PRICE_BENCHMARK_WARN_THRESHOLD_PCT && bench != null
                    const kg = Number(ln.totalWeightKg)
                    const saving =
                      showWarn && Number.isFinite(kg) && kg > 0
                        ? Math.round((num - bench!.ratePerKg) * kg * 100) / 100
                        : null
                    return (
                      <li key={ln.id} className="border-b border-ds-line/50 pb-2 last:border-0 last:pb-0">
                        <p className="font-medium text-ds-ink">
                          {ln.boardGrade} · {ln.gsm} GSM · {ln.grainDirection}
                        </p>
                        <p className="text-ds-ink-faint">
                          Sheets {ln.totalSheets.toLocaleString('en-IN')} · Weight{' '}
                          {Number(ln.totalWeightKg).toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg
                        </p>
                        <label
                          className={`mt-1 flex flex-wrap items-center gap-2 text-[11px] ${hot ? 'text-rose-300' : 'text-ds-ink-muted'}`}
                        >
                          <span className="shrink-0">Rate / kg (₹)</span>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={lineRates[ln.id] ?? ''}
                            onChange={(e) =>
                              setLineRates((prev) => ({ ...prev, [ln.id]: e.target.value }))
                            }
                            disabled={!!draft.dispatchedAt}
                            className={`w-28 rounded border px-1.5 py-0.5 font-mono tabular-nums text-foreground disabled:opacity-50 ${
                              hot
                                ? 'border-rose-500/70 bg-rose-950/40 ring-1 ring-rose-500/30'
                                : 'border-ds-line/60 bg-ds-card'
                            }`}
                          />
                          <PriceTrendSparkline
                            data={intelLine.trend6m}
                            tooltip={intelLine.trendTooltip}
                          />
                        </label>
                        {showWarn ? (
                          <div className="mt-1.5 rounded-md border border-rose-500/25 bg-rose-500/10 px-2 py-1.5 text-[10px] text-rose-500 leading-snug">
                            <p>
                              Rate is {varPct!.toFixed(1)}% above market best (₹{bench!.ratePerKg.toFixed(2)}{' '}
                              from {bench!.supplierName}).
                            </p>
                            {saving != null && saving > 0 ? (
                              <p className="mt-0.5 font-mono tabular-nums">
                                Potential Saving: ₹
                                {saving.toLocaleString('en-IN', {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}
                                .
                              </p>
                            ) : null}
                          </div>
                        ) : null}
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
                    className="rounded-md border border-ds-line/60 px-3 py-1.5 text-ds-ink-muted hover:bg-ds-elevated"
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
          className="fixed inset-0 z-[60] flex items-center justify-center bg-background/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Short-close vendor PO"
        >
          <div
            className={`w-full max-w-md rounded-xl border bg-background p-4 shadow-2xl ring-1 ring-ds-warning/35 ${STRATEGIC_SOURCING_GOLD_BORDER}`}
          >
            <h3 className={`text-[13px] font-bold tracking-tight ${STRATEGIC_SOURCING_GOLD}`}>
              Short-close vendor PO
            </h3>
            <p className="text-[10px] text-neutral-500 mt-1.5 leading-snug">
              Authority: <span className="text-ds-warning">≥95%</span> received vs ordered. Sets status to{' '}
              <span className="text-ds-ink-muted">Closed</span>, flags short-close, and writes a full audit trail (
              reason + remarks).
            </p>
            <div
              className={`mt-3 space-y-1.5 rounded-lg border border-ds-line/30 ${STRATEGIC_SOURCING_GOLD_SOFT} p-2.5 text-[10px]`}
            >
              <div className="flex justify-between gap-2 text-neutral-500">
                <span>Ordered (kg)</span>
                <span className={`text-ds-ink tabular-nums ${industrialMono}`}>
                  {spotlightRow.procurementHud.shortClose.orderedKg.toLocaleString('en-IN', {
                    maximumFractionDigits: 3,
                  })}
                </span>
              </div>
              <div className="flex justify-between gap-2 text-neutral-500">
                <span>Received (kg)</span>
                <span className={`text-ds-ink tabular-nums ${industrialMono}`}>
                  {spotlightRow.procurementHud.shortClose.receivedKg.toLocaleString('en-IN', {
                    maximumFractionDigits: 3,
                  })}
                </span>
              </div>
              <div className="flex justify-between gap-2 text-ds-ink/95 font-semibold border-t border-ds-line/50 pt-1.5">
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
            <label className="mt-3 block text-[9px] text-neutral-500 uppercase tracking-wide font-bold">
              Reason
              <select
                value={shortCloseReasonPick}
                onChange={(e) => setShortCloseReasonPick(e.target.value as ShortCloseReason)}
                className="mt-1 w-full rounded-md border border-ds-line/40 bg-ds-main px-2 py-1.5 text-ds-ink text-[11px] normal-case font-medium"
              >
                {SHORT_CLOSE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-2 block text-[9px] text-neutral-500 uppercase tracking-wide font-bold">
              Remarks <span className="text-ds-warning">(required, min 10)</span>
              <textarea
                value={shortCloseRemarks}
                onChange={(e) => setShortCloseRemarks(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-md border border-ds-line/40 bg-background px-2 py-1.5 text-[11px] text-ds-ink placeholder:text-neutral-700"
                placeholder="Document context for audit (e.g. variance detail, director instruction)…"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShortCloseModalOpen(false)}
                className="rounded-md border border-ds-line/40 bg-background px-3 py-1.5 text-[11px] text-ds-ink-muted hover:border-ds-line/50 hover:text-ds-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={shortCloseSubmitting || shortCloseRemarks.trim().length < 10}
                onClick={() => void confirmShortClosePo()}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-ds-warning/55 bg-ds-warning/10 px-3 py-1.5 text-[11px] font-bold text-ds-ink hover:bg-ds-warning/10 disabled:opacity-45"
              >
                <ListChecks className="h-3.5 w-3.5" aria-hidden />
                {shortCloseSubmitting ? 'Closing…' : 'Confirm short-close'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {shortageActionModal ? (
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-background/95 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Shortage action required"
        >
          <div
            className={`w-full max-w-md rounded-xl border bg-background p-4 shadow-2xl ring-1 ring-ds-warning/35 ${STRATEGIC_SOURCING_GOLD_BORDER}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={`text-[13px] font-bold tracking-tight leading-snug ${STRATEGIC_SOURCING_GOLD}`}>
              Action Required: Rejection Shortage (
              <span className={ledgerMono}>
                {shortageActionModal.rejectKg.toLocaleString('en-IN', { maximumFractionDigits: 3 })}
              </span>{' '}
              KG)
            </h3>
            <p className="text-[9px] text-neutral-500 mt-2 leading-snug">
              GRN return logged — choose how to handle the outstanding mill balance. Pure black gate; mono quantities;
              signed Anik Dua procurement lane.
            </p>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                disabled={shortageActionSubmitting != null}
                onClick={() => void submitShortageReplacement()}
                className="rounded-lg border border-ds-warning/50 bg-ds-warning/10 px-3 py-3 text-[11px] font-bold text-ds-ink hover:bg-ds-warning/10 disabled:opacity-50 ring-1 ring-ds-warning/35"
              >
                {shortageActionSubmitting === 'replacement' ? 'Saving…' : 'Request Replacement'}
              </button>
              <button
                type="button"
                disabled={shortageActionSubmitting != null || !canAuthorizeShortClose}
                title={
                  canAuthorizeShortClose
                    ? 'Close PO for short-received balance'
                    : 'Requires md, director, or procurement_manager'
                }
                onClick={() => void submitShortageShortClose()}
                className="rounded-lg border border-orange-500/50 bg-orange-950/25 px-3 py-3 text-[11px] font-bold text-orange-100 hover:bg-orange-950/40 disabled:opacity-45 ring-1 ring-ds-warning/35"
              >
                {shortageActionSubmitting === 'short_close' ? 'Closing…' : 'Short-Close Balance'}
              </button>
            </div>
            <label className="mt-3 block text-[9px] text-neutral-500 font-bold uppercase tracking-wide">
              Replacement ETA <span className="text-ds-warning normal-case">(required for replacement)</span>
              <input
                type="datetime-local"
                value={shortageReplacementEta}
                onChange={(e) => setShortageReplacementEta(e.target.value)}
                className={`mt-1 w-full rounded-md border border-ds-line/40 bg-ds-main px-2 py-2 text-[12px] text-ds-ink ${ledgerMono}`}
              />
            </label>
            <label className="mt-2 block text-[9px] text-neutral-500 font-bold uppercase tracking-wide">
              Short-close remarks <span className="text-rose-500/80 normal-case">(min 10 chars)</span>
              <textarea
                value={shortageShortCloseRemarks}
                onChange={(e) => setShortageShortCloseRemarks(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded-md border border-ds-line/40 bg-background px-2 py-1.5 text-[11px] text-ds-ink placeholder:text-neutral-700"
                placeholder="Closed — short received after rejection (audit)…"
              />
            </label>
            <p className="mt-2 text-[8px] text-neutral-600">
              Replacement keeps PO open and flags <span className="text-rose-300/90">Awaiting_Replacement</span>; lead
              buffer uses your ETA vs production target (
              <span className={ledgerMono}>&lt;48h</span> → amber/red pulse on the row).
            </p>
          </div>
        </div>
      ) : null}

      {penaltyFlow ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-background/92 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Quality penalty and debit draft"
        >
          <div
            className={`w-full max-w-md rounded-xl border bg-background p-4 shadow-2xl ring-1 ring-ds-warning/35 ${STRATEGIC_SOURCING_GOLD_BORDER}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={`text-[12px] font-bold tracking-tight ${STRATEGIC_SOURCING_GOLD}`}>
              Financial ledger handoff — penalty tranche
            </h3>
            <p className="text-[9px] text-neutral-600 mt-1 leading-snug">
              Technical variance when Actual GSM &lt; Ordered GSM. Pure black record; mono for GSM and ₹.
            </p>
            <div className="mt-3 space-y-2 rounded-lg border border-ds-line/30 bg-ds-main/40 p-2.5 text-[10px]">
              <div className={`flex justify-between gap-2 text-neutral-500 ${ledgerMono}`}>
                <span>Ordered GSM vs Actual</span>
                <span className="text-ds-ink/95 font-semibold">
                  {penaltyFlow.orderedGsm} / {penaltyFlow.actualGsm}
                </span>
              </div>
              <div className={`flex justify-between gap-2 text-neutral-500 ${ledgerMono}`}>
                <span>Technical shortfall</span>
                <span className="text-ds-warning font-semibold">{penaltyFlow.shortfallPct.toFixed(2)}%</span>
              </div>
              <div className={`flex justify-between gap-2 text-neutral-500 ${ledgerMono}`}>
                <span>Recommended debit</span>
                <span className="text-ds-warning font-bold">
                  ₹{penaltyFlow.recommendedInr.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <pre
                className={`mt-2 whitespace-pre-wrap border-t border-ds-line/40 pt-2 text-[8px] text-neutral-500 leading-relaxed ${ledgerMono}`}
              >
                {penaltyFlow.proofLines.join('\n')}
              </pre>
            </div>
            <div className="mt-4 space-y-2">
              <p className={`text-[9px] text-neutral-500 ${ledgerMono}`}>
                Penalty qty (kg):{' '}
                <span className="text-ds-warning font-semibold">{penaltyFlow.penaltyQtyKg}</span>
              </p>
              <p className="text-[9px] text-neutral-500">
                Queue this amount to the financial ledger. Settlement: Quality Settlement Authorized by you —
                Pending Financial Finalization by Saachi.
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={debitDraftSubmitting}
                  onClick={() => setPenaltyFlow(null)}
                  className="rounded-md border border-ds-line/40 bg-background px-3 py-1.5 text-[10px] text-neutral-500"
                >
                  Close
                </button>
                <button
                  type="button"
                  disabled={debitDraftSubmitting}
                  onClick={() => void submitDebitDraft(penaltyFlow.receiptId)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-ds-warning/55 bg-ds-warning/10 px-3 py-1.5 text-[10px] font-bold text-ds-ink"
                >
                  <IndianRupee className="h-3.5 w-3.5" aria-hidden />
                  {debitDraftSubmitting ? 'Sending…' : 'Draft debit note'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </IndustrialModuleShell>
  )
}
