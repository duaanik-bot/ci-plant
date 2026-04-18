import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  aggregateFromStoredRequirements,
  pickSuggestedBoardSupplier,
  type AggregatedMaterialRequirement,
} from '@/lib/procurement-mrp-service'
import { computeMaterialReadinessVitals } from '@/lib/material-readiness-vitals'
import {
  computeVendorPoLeadBuffers,
  worstLeadBufferForRequirement,
  type LeadBufferSnapshot,
} from '@/lib/procurement-lead-buffer'
import {
  weightVarianceUiLevel,
  type WeightVarianceUiLevel,
} from '@/lib/weight-reconciliation'
import type { MaterialReadinessRollup } from '@/lib/procurement-mrp-service'
import {
  computeVendorReliabilityScores,
  type ReliabilityGrade,
} from '@/lib/vendor-reliability-scorecard'
import {
  effectiveLogisticsLane,
  isInTransitStale,
} from '@/lib/procurement-logistics-hud'
import { isVendorPoPostDispatchReceiving } from '@/lib/vendor-po-post-dispatch'
import {
  canAuthorizeShortCloseRole,
  shortCloseSnapshotsForVendorPos,
  type VendorPoShortCloseSnapshot,
} from '@/lib/vendor-po-short-close'
import { PROCUREMENT_SHORTAGE_AWAITING_REPLACEMENT } from '@/lib/vendor-po-shortage'
import type { CashFlowTermsDto } from '@/lib/procurement-payment-terms'
import {
  buildCashFlowTermsFromVendorPo,
  buildProvisionalCashFlowTerms,
  loadBetterTermsIndex,
  loadVendorPoCashRows,
} from '@/lib/procurement-payment-terms'
import { boardGradesMatch, normalizeBoardKey } from '@/lib/procurement-price-benchmark'
import { computeLandedRatePerKg, freightPctOfBasicRate } from '@/lib/total-landed-cost'
import {
  aggregateAllocatedSheetsByBoardGsm,
  aggregatePhysicalPaperByBoardGsm,
  computeReorderRadarForRow,
  type ReorderRadarSnapshot,
} from '@/lib/reorder-radar'

export const dynamic = 'force-dynamic'

const ACTIVE_LINE_PROC_STATUSES = [
  'pending',
  'on_order',
  'dispatched',
  'paper_ordered',
  'received',
] as const

type LineSupplierIndex = Map<string, Set<string>>

export type LineReconciliationDto = {
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

type WeightVarianceAgg = {
  displayPercent: number
  absPercent: number
  varianceKg: number
  level: WeightVarianceUiLevel
}

export type SupplierReliabilityDto = {
  grade: ReliabilityGrade
  compositeScore: number
  deliveryScore: number
  weightScore: number
}

export type ProcurementHudDto = {
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
    /** True when this row reflects an already short-closed vendor PO. */
    isRecord: boolean
    /** Dispatched PO: received/ordered ≥ authority threshold (95%). */
    authorityGateMet: boolean
    completionPct: number
    orderedKg: number
    receivedKg: number
    closedByName?: string | null
    closedReason?: string | null
  } | null
  /** Primary mill PO is awaiting replacement material after GRN rejection. */
  shortageAwaitingReplacement: boolean
}

type VpoHudRow = {
  id: string
  poNumber: string
  status: string
  isShortClosed: boolean
  shortClosedByName: string | null
  shortCloseReason: string | null
  dispatchedAt: Date | null
  logisticsStatus: string | null
  lrNumber: string | null
  vehicleNumber: string | null
  estimatedArrivalAt: Date | null
  transporterName: string | null
  logisticsUpdatedAt: Date | null
  supplierName: string
  procurementShortageFlag: string | null
}

function logisticsDtoFromVpo(vpo: VpoHudRow): NonNullable<ProcurementHudDto['logistics']> {
  return {
    transporterName: vpo.transporterName,
    lrNumber: vpo.lrNumber,
    vehicleNumber: vpo.vehicleNumber,
    estimatedArrivalAt: vpo.estimatedArrivalAt?.toISOString() ?? null,
    logisticsStatus: vpo.logisticsStatus,
    logisticsUpdatedAt: vpo.logisticsUpdatedAt?.toISOString() ?? null,
  }
}

function resolvePrimaryVendorPoId(
  r: AggregatedMaterialRequirement,
  leadBuffer: LeadBufferSnapshot | null,
  lineIdToVendorPoIds: Map<string, string[]>,
  vpoById: Map<string, VpoHudRow>,
): string | null {
  if (leadBuffer?.vendorPoId && vpoById.has(leadBuffer.vendorPoId)) {
    return leadBuffer.vendorPoId
  }
  let closedShortId: string | null = null
  for (const c of r.contributions) {
    const ids = lineIdToVendorPoIds.get(c.poLineItemId) ?? []
    for (const vid of ids) {
      const v = vpoById.get(vid)
      if (v && isVendorPoPostDispatchReceiving(v.status)) return vid
      if (v?.status === 'closed' && v.isShortClosed && !closedShortId) closedShortId = vid
    }
  }
  return closedShortId
}

function buildShortCloseHudDto(
  primary: VpoHudRow | null,
  shortCloseByVpoId: Map<string, VendorPoShortCloseSnapshot>,
): ProcurementHudDto['shortClose'] {
  if (!primary) return null
  const s = shortCloseByVpoId.get(primary.id)
  if (primary.status === 'closed' && primary.isShortClosed) {
    return {
      isRecord: true,
      authorityGateMet: false,
      completionPct: s?.completionPct ?? 0,
      orderedKg: s?.orderedKg ?? 0,
      receivedKg: s?.receivedKg ?? 0,
      closedByName: primary.shortClosedByName,
      closedReason: primary.shortCloseReason,
    }
  }
  if (!isVendorPoPostDispatchReceiving(primary.status) || primary.isShortClosed) return null
  if (!s) return null
  return {
    isRecord: false,
    authorityGateMet: s.eligible,
    completionPct: s.completionPct,
    orderedKg: s.orderedKg,
    receivedKg: s.receivedKg,
  }
}

function procurementRowSortKey(hud: ProcurementHudDto, rollup: MaterialReadinessRollup): number {
  if (hud.variant === 'short_closed') return 4
  return readinessSortKey(rollup)
}

function buildProcurementHud(
  r: AggregatedMaterialRequirement,
  leadBuffer: LeadBufferSnapshot | null,
  lineIdToVendorPoIds: Map<string, string[]>,
  vpoById: Map<string, VpoHudRow>,
  shortCloseByVpoId: Map<string, VendorPoShortCloseSnapshot>,
): ProcurementHudDto {
  const primaryId = resolvePrimaryVendorPoId(r, leadBuffer, lineIdToVendorPoIds, vpoById)
  const primary = primaryId ? vpoById.get(primaryId) ?? null : null
  const shortClose = buildShortCloseHudDto(primary, shortCloseByVpoId)
  const rollup = r.readinessRollup
  const shortageAwaitingReplacement =
    primary?.procurementShortageFlag === PROCUREMENT_SHORTAGE_AWAITING_REPLACEMENT

  if (primary?.status === 'closed' && primary.isShortClosed) {
    return {
      variant: 'short_closed',
      label: 'Short-Closed',
      logisticsStale: false,
      primaryVendorPoId: primary.id,
      primaryVendorPoNumber: primary.poNumber,
      primarySupplierName: primary.supplierName,
      logistics: null,
      shortClose,
      shortageAwaitingReplacement: false,
    }
  }

  const lane = primary ? effectiveLogisticsLane(primary) : null
  const stale = primary ? isInTransitStale(lane, primary.estimatedArrivalAt) : false

  if (primary && lane) {
    const log = logisticsDtoFromVpo(primary)
    if (lane === 'at_gate') {
      return {
        variant: 'at_gate',
        label: 'At Gate',
        logisticsStale: false,
        primaryVendorPoId: primary.id,
        primaryVendorPoNumber: primary.poNumber,
        primarySupplierName: primary.supplierName,
        logistics: log,
        shortClose,
        shortageAwaitingReplacement,
      }
    }
    if (lane === 'in_transit') {
      return {
        variant: stale ? 'in_transit_stale' : 'in_transit',
        label: stale ? 'In-Transit · overdue' : 'In-Transit',
        logisticsStale: stale,
        primaryVendorPoId: primary.id,
        primaryVendorPoNumber: primary.poNumber,
        primarySupplierName: primary.supplierName,
        logistics: log,
        shortClose,
        shortageAwaitingReplacement,
      }
    }
    if (lane === 'mill_dispatched') {
      return {
        variant: 'mill_dispatched',
        label: 'Mill Dispatched',
        logisticsStale: false,
        primaryVendorPoId: primary.id,
        primaryVendorPoNumber: primary.poNumber,
        primarySupplierName: primary.supplierName,
        logistics: log,
        shortClose,
        shortageAwaitingReplacement,
      }
    }
  }

  const rollLabels: Record<
    MaterialReadinessRollup,
    { variant: ProcurementHudDto['variant']; label: string }
  > = {
    planned: { variant: 'planned', label: 'Planned' },
    ordered: { variant: 'ordered', label: 'Ordered' },
    in_transit: { variant: 'in_transit', label: 'In-Transit' },
    received: { variant: 'received', label: 'Received' },
    mixed: { variant: 'mixed', label: 'Mixed' },
  }
  const fb = rollLabels[rollup]
  return {
    variant: fb.variant,
    label: fb.label,
    logisticsStale: false,
    primaryVendorPoId: primary?.id ?? null,
    primaryVendorPoNumber: primary?.poNumber ?? null,
    primarySupplierName: primary?.supplierName ?? null,
    logistics: primary ? logisticsDtoFromVpo(primary) : null,
    shortClose: buildShortCloseHudDto(primary, shortCloseByVpoId),
    shortageAwaitingReplacement,
  }
}

export type LandedCostSnapshotDto = {
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

type VendorPoLineForLanded = {
  id: string
  boardGrade: string
  gsm: number
  linkedPoLineIds: unknown
  totalWeightKg: unknown
  ratePerKg: unknown
  freightTotalInr: unknown
  unloadingChargesInr: unknown
  insuranceMiscInr: unknown
  landedRatePerKg: unknown
}

function buildLandedCostSnapshot(
  primaryVpoId: string | null,
  boardType: string,
  gsm: number,
  requirementTotalKg: number,
  vpoLinesById: Map<string, VendorPoLineForLanded[]>,
): LandedCostSnapshotDto {
  const empty: LandedCostSnapshotDto = {
    vendorMaterialLineId: null,
    vendorPoId: primaryVpoId,
    basicRatePerKg: null,
    landedRatePerKg: null,
    totalWeightKg: requirementTotalKg,
    freightTotalInr: 0,
    unloadingChargesInr: 0,
    insuranceMiscInr: 0,
    freightPctOfBasic: null,
  }
  if (!primaryVpoId) return empty
  const lines = vpoLinesById.get(primaryVpoId) ?? []
  const norm = normalizeBoardKey(boardType)
  const ln = lines.find((l) => l.gsm === gsm && boardGradesMatch(l.boardGrade, norm))
  if (!ln) return empty
  const w = Number(ln.totalWeightKg)
  const basic = ln.ratePerKg != null ? Number(ln.ratePerKg) : null
  const freight = Number(ln.freightTotalInr ?? 0)
  const unload = Number(ln.unloadingChargesInr ?? 0)
  const ins = Number(ln.insuranceMiscInr ?? 0)
  let landed: number | null = null
  if (basic != null && Number.isFinite(basic) && w > 0) {
    landed = computeLandedRatePerKg({
      basicRatePerKg: basic,
      totalWeightKg: w,
      freightTotalInr: freight,
      unloadingChargesInr: unload,
      insuranceMiscInr: ins,
    })
  }
  const freightPct = basic != null && basic > 0 ? freightPctOfBasicRate(basic, w, freight) : null
  return {
    vendorMaterialLineId: ln.id,
    vendorPoId: primaryVpoId,
    basicRatePerKg: basic,
    landedRatePerKg: landed,
    totalWeightKg: w,
    freightTotalInr: freight,
    unloadingChargesInr: unload,
    insuranceMiscInr: ins,
    freightPctOfBasic: freightPct,
  }
}

type RequirementRow = AggregatedMaterialRequirement & {
  leadBuffer: LeadBufferSnapshot | null
  weightVariance: WeightVarianceAgg | null
  supplierReliability: SupplierReliabilityDto | null
  procurementHud: ProcurementHudDto
  cashFlowTerms: CashFlowTermsDto
  landedCost: LandedCostSnapshotDto
  reorderRadar: ReorderRadarSnapshot
}

function readinessSortKey(x: MaterialReadinessRollup): number {
  if (x === 'planned') return 0
  if (x === 'ordered') return 1
  if (x === 'in_transit') return 2
  if (x === 'mixed') return 3
  if (x === 'received') return 4
  return 5
}

function worstWeightVariance(
  contributions: AggregatedMaterialRequirement['contributions'],
  reconByLine: Map<
    string,
    { variancePercent: unknown; varianceKg: unknown }
  >,
): WeightVarianceAgg | null {
  let worst: WeightVarianceAgg | null = null
  for (const c of contributions) {
    const rec = reconByLine.get(c.poLineItemId)
    if (!rec || rec.variancePercent == null) continue
    const pct = Number(rec.variancePercent)
    if (!Number.isFinite(pct)) continue
    const abs = Math.abs(pct)
    const vkg = Number(rec.varianceKg)
    const level = weightVarianceUiLevel(abs)
    if (!worst || abs > worst.absPercent) {
      worst = { displayPercent: pct, absPercent: abs, varianceKg: vkg, level }
    }
  }
  return worst
}

function toLineReconDto(row: {
  invoiceWeightKg: unknown
  scaleWeightKg: unknown
  coreWeightKg: unknown
  netReceivedKg: unknown
  varianceKg: unknown
  variancePercent: unknown
  ratePerKgInr: unknown
  invoiceNumber: string | null
  reconciliationStatus: string
  vendorMaterialPoLineId: string | null
  debitNoteDraftText: string | null
}): LineReconciliationDto {
  return {
    invoiceWeightKg: Number(row.invoiceWeightKg),
    scaleWeightKg: Number(row.scaleWeightKg),
    coreWeightKg: Number(row.coreWeightKg),
    netReceivedKg: Number(row.netReceivedKg),
    varianceKg: Number(row.varianceKg),
    variancePercent: row.variancePercent != null ? Number(row.variancePercent) : null,
    ratePerKgInr: row.ratePerKgInr != null ? Number(row.ratePerKgInr) : null,
    invoiceNumber: row.invoiceNumber,
    reconciliationStatus: row.reconciliationStatus,
    vendorMaterialPoLineId: row.vendorMaterialPoLineId,
    debitNoteDraftText: row.debitNoteDraftText,
  }
}

function buildLineSupplierIndex(
  vendorPos: {
    supplier: { name: string }
    lines: { linkedPoLineIds: unknown }[]
  }[],
): LineSupplierIndex {
  const m = new Map<string, Set<string>>()
  for (const vpo of vendorPos) {
    const nameLower = vpo.supplier.name.trim().toLowerCase()
    for (const ln of vpo.lines) {
      const raw = ln.linkedPoLineIds
      const ids = Array.isArray(raw) ? (raw as string[]) : []
      for (const id of ids) {
        if (!m.has(id)) m.set(id, new Set())
        m.get(id)!.add(nameLower)
      }
    }
  }
  return m
}

function requirementMatchesQuery(
  r: RequirementRow,
  q: string,
  lineSupplierIndex: LineSupplierIndex,
): boolean {
  if (!q) return true
  const lb = r.leadBuffer
  const supplierHay = r.contributions
    .flatMap((c) => Array.from(lineSupplierIndex.get(c.poLineItemId) ?? []))
    .join(' ')
  const hay = [
    r.key,
    r.boardType,
    String(r.gsm),
    r.grainDirection,
    r.sheetSizeLabel,
    String(r.reorderRadar.netAvailable),
    String(r.reorderRadar.physicalSheets),
    String(r.reorderRadar.allocatedSheets),
    r.reorderRadar.stockStatus,
    r.reorderRadar.safetyStatus,
    supplierHay,
    r.suggestedSupplierName ?? '',
    lb?.vendorPoNumber ?? '',
    r.procurementHud.label,
    r.cashFlowTerms.badgeLabel,
    r.cashFlowTerms.projectedPaymentYmd ?? '',
    String(r.landedCost.basicRatePerKg ?? ''),
    String(r.landedCost.landedRatePerKg ?? ''),
    r.procurementHud.logistics?.lrNumber ?? '',
    r.procurementHud.logistics?.vehicleNumber ?? '',
    r.procurementHud.logistics?.transporterName ?? '',
    ...r.contributions.flatMap((c) => [
      c.poNumber,
      c.customerName,
      c.cartonName,
      c.poLineItemId,
      c.poId,
      c.materialProcurementStatus,
      c.jobCardNumber != null ? `jc-${c.jobCardNumber}` : '',
      String(c.jobCardNumber ?? ''),
    ]),
  ]
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

function riskRank(lb: LeadBufferSnapshot | null): number {
  if (!lb) return 4
  if (lb.level === 'critical') return 0
  if (lb.level === 'at_risk') return 1
  return 2
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim().toLowerCase() ?? ''
  const riskParam = req.nextUrl.searchParams.get('risk')?.trim().toLowerCase() ?? ''
  const vendorRiskParam = req.nextUrl.searchParams.get('vendorRisk')?.trim().toLowerCase() ?? ''
  const stockOutRiskParam = req.nextUrl.searchParams.get('stockOutRisk')?.trim().toLowerCase() ?? ''

  const [suppliers, vitals, vendorPosBase, rows, session] = await Promise.all([
    db.supplier.findMany({ where: { active: true } }),
    computeMaterialReadinessVitals(db),
    db.vendorMaterialPurchaseOrder.findMany({
      where: {
        status: { in: ['draft', 'confirmed', 'dispatched', 'partially_received', 'fully_received'] },
      },
      include: {
        supplier: { select: { id: true, name: true } },
        lines: {
          select: {
            id: true,
            boardGrade: true,
            gsm: true,
            linkedPoLineIds: true,
            totalWeightKg: true,
            ratePerKg: true,
            freightTotalInr: true,
            unloadingChargesInr: true,
            insuranceMiscInr: true,
            landedRatePerKg: true,
          },
        },
      },
    }),
    db.materialQueue.findMany({
      where: {
        lineItem: {
          materialProcurementStatus: { in: [...ACTIVE_LINE_PROC_STATUSES] },
          po: { status: 'confirmed' },
        },
      },
      include: {
        lineItem: true,
        purchaseOrder: {
          include: { customer: { select: { name: true } } },
        },
      },
      orderBy: { calculatedAt: 'desc' },
    }),
    getServerSession(authOptions),
  ])

  const activeLineIds = new Set(rows.map((row) => row.lineItem.id))
  const shortClosedLinked = await db.vendorMaterialPurchaseOrder.findMany({
    where: { status: 'closed', isShortClosed: true },
    include: {
      supplier: { select: { id: true, name: true } },
      lines: {
        select: {
          id: true,
          boardGrade: true,
          gsm: true,
          linkedPoLineIds: true,
          totalWeightKg: true,
          ratePerKg: true,
          freightTotalInr: true,
          unloadingChargesInr: true,
          insuranceMiscInr: true,
          landedRatePerKg: true,
        },
      },
    },
  })
  const shortClosedForWorkbench = shortClosedLinked.filter((vpo) =>
    vpo.lines.some((ln) => {
      const ids = Array.isArray(ln.linkedPoLineIds) ? (ln.linkedPoLineIds as string[]) : []
      return ids.some((id) => activeLineIds.has(id))
    }),
  )
  const baseVpoIds = new Set(vendorPosBase.map((v) => v.id))
  const vendorPosForIndex = [
    ...vendorPosBase,
    ...shortClosedForWorkbench.filter((v) => !baseVpoIds.has(v.id)),
  ]

  const vpoLinesById = new Map<string, VendorPoLineForLanded[]>(
    vendorPosForIndex.map((v) => [v.id, v.lines as VendorPoLineForLanded[]]),
  )

  const canAuthorizeShortClose = canAuthorizeShortCloseRole(session?.user?.role)

  const { byVendorPoId, lineIdToVendorPoIds, atRiskVendorPoCount } = await computeVendorPoLeadBuffers(
    db,
    vendorPosForIndex,
  )

  const vendorScores = await computeVendorReliabilityScores(db)

  const suggested = pickSuggestedBoardSupplier(suppliers)
  const lineSupplierIndex = buildLineSupplierIndex(vendorPosForIndex)

  const shortCloseByVpoId = await shortCloseSnapshotsForVendorPos(db, vendorPosForIndex)

  const supplierTermsById = new Map(suppliers.map((s) => [s.id, s.paymentTermsDays ?? 30]))
  const [betterTermsIndex, cashByVpoId] = await Promise.all([
    loadBetterTermsIndex(db),
    loadVendorPoCashRows(
      db,
      vendorPosForIndex.map((v) => v.id),
    ),
  ])

  const vpoById = new Map<string, VpoHudRow>(
    vendorPosForIndex.map((v) => [
      v.id,
      {
        id: v.id,
        poNumber: v.poNumber,
        status: v.status,
        isShortClosed: v.isShortClosed,
        shortClosedByName: v.shortClosedByName,
        shortCloseReason: v.shortCloseReason,
        dispatchedAt: v.dispatchedAt,
        logisticsStatus: v.logisticsStatus,
        lrNumber: v.lrNumber,
        vehicleNumber: v.vehicleNumber,
        estimatedArrivalAt: v.estimatedArrivalAt,
        transporterName: v.transporterName,
        logisticsUpdatedAt: v.logisticsUpdatedAt,
        supplierName: v.supplier.name,
        procurementShortageFlag: v.procurementShortageFlag ?? null,
      },
    ]),
  )

  const flat = rows.map((mr) => ({
    mr,
    line: mr.lineItem,
    po: mr.purchaseOrder,
  }))

  function reliabilityForSupplier(supplierId: string | null): SupplierReliabilityDto | null {
    if (!supplierId) return null
    const snap = vendorScores.get(supplierId)
    if (!snap) return null
    return {
      grade: snap.grade,
      compositeScore: snap.compositeScore,
      deliveryScore: snap.deliveryScore,
      weightScore: snap.weightScore,
    }
  }

  const aggregatedCore = aggregateFromStoredRequirements(flat, suppliers)
  const [physicalByBg, policyRows] = await Promise.all([
    aggregatePhysicalPaperByBoardGsm(db),
    db.paperSpecReorderPolicy.findMany(),
  ])
  const policyByKey = new Map(policyRows.map((p) => [p.radarKey, p]))
  const allocatedByBg = aggregateAllocatedSheetsByBoardGsm(aggregatedCore)

  const baseRequirements = aggregatedCore.map((r) => {
    const pol = policyByKey.get(r.key)
    const reorderRadar = computeReorderRadarForRow({
      boardType: r.boardType,
      gsm: r.gsm,
      radarKey: r.key,
      totalSheetsDemand: r.totalSheets,
      physicalByBoardGsm: physicalByBg,
      allocatedByBoardGsm: allocatedByBg,
      minimumThreshold: pol?.minimumThreshold ?? 0,
      maximumBuffer: pol?.maximumBuffer ?? 0,
    })
    const leadBuffer = worstLeadBufferForRequirement(r.contributions, lineIdToVendorPoIds, byVendorPoId)
    const procurementHud = buildProcurementHud(r, leadBuffer, lineIdToVendorPoIds, vpoById, shortCloseByVpoId)
    const primaryId = procurementHud.primaryVendorPoId
    const cashFlowTerms: CashFlowTermsDto = (() => {
      if (primaryId) {
        const row = cashByVpoId.get(primaryId)
        if (row) {
          return buildCashFlowTermsFromVendorPo(
            row,
            procurementHud.primarySupplierName,
            r.boardType,
            r.gsm,
            betterTermsIndex,
          )
        }
      }
      const sid = r.suggestedSupplierId
      const days = sid != null ? supplierTermsById.get(sid) ?? 30 : 30
      return buildProvisionalCashFlowTerms(
        days,
        procurementHud.primarySupplierName ?? r.suggestedSupplierName,
        r.boardType,
        r.gsm,
        sid,
        betterTermsIndex,
      )
    })()
    const landedCost = buildLandedCostSnapshot(
      primaryId,
      r.boardType,
      r.gsm,
      r.totalWeightKg,
      vpoLinesById,
    )
    return {
      ...r,
      reorderRadar,
      leadBuffer,
      supplierReliability: reliabilityForSupplier(r.suggestedSupplierId),
      procurementHud,
      cashFlowTerms,
      landedCost,
    }
  })

  const vendorRiskIndexCount = baseRequirements.filter(
    (r) => r.supplierReliability?.grade === 'C',
  ).length

  const lineIds = Array.from(
    new Set(baseRequirements.flatMap((r) => r.contributions.map((c) => c.poLineItemId))),
  )
  const reconRows =
    lineIds.length > 0
      ? await db.materialWeightReconciliation.findMany({
          where: { poLineItemId: { in: lineIds } },
        })
      : []
  const reconByLine = new Map(reconRows.map((row) => [row.poLineItemId, row]))
  const lineReconciliations: Record<string, LineReconciliationDto> = {}
  for (const row of reconRows) {
    lineReconciliations[row.poLineItemId] = toLineReconDto(row)
  }

  let requirements: RequirementRow[] = baseRequirements.map((r) => ({
    ...r,
    weightVariance: worstWeightVariance(r.contributions, reconByLine),
    supplierReliability: r.supplierReliability,
    procurementHud: r.procurementHud,
    cashFlowTerms: r.cashFlowTerms,
    landedCost: r.landedCost,
  }))

  const stockOutRisksCount = (() => {
    const keys = new Set<string>()
    for (const r of baseRequirements) {
      if (r.reorderRadar.isProcurementRisk) keys.add(r.reorderRadar.boardGsmKey)
    }
    return keys.size
  })()

  if (q) {
    requirements = requirements.filter((r) => requirementMatchesQuery(r, q, lineSupplierIndex))
  }

  if (riskParam === 'high') {
    requirements = requirements.filter(
      (r) => r.leadBuffer && (r.leadBuffer.level === 'at_risk' || r.leadBuffer.level === 'critical'),
    )
  }

  if (vendorRiskParam === 'high') {
    requirements = requirements.filter((r) => r.supplierReliability?.grade === 'C')
  }

  if (stockOutRiskParam === 'high') {
    requirements = requirements.filter((r) => r.reorderRadar.isProcurementRisk)
  }

  requirements.sort((a, b) => {
    const pa = a.industrialPriority ? 1 : 0
    const pb = b.industrialPriority ? 1 : 0
    if (pa !== pb) return pb - pa
    const rr = riskRank(a.leadBuffer) - riskRank(b.leadBuffer)
    if (rr !== 0) return rr
    const ra = procurementRowSortKey(a.procurementHud, a.readinessRollup)
    const rb = procurementRowSortKey(b.procurementHud, b.readinessRollup)
    if (ra !== rb) return ra - rb
    return a.oldestCalculatedAt.localeCompare(b.oldestCalculatedAt)
  })

  return NextResponse.json({
    requirements,
    lineReconciliations,
    suggestedSupplier: suggested ? { id: suggested.id, name: suggested.name } : null,
    vitals,
    atRiskVendorPoCount,
    vendorRiskIndexCount,
    stockOutRisksCount,
    canAuthorizeShortClose,
    factoryTimeZone: 'Asia/Kolkata',
  })
}
