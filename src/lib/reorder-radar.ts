import type { PrismaClient, Supplier } from '@prisma/client'
import {
  boardGradesMatch,
  computeMarketBenchmark30d,
  normalizeBoardKey,
} from '@/lib/procurement-price-benchmark'
import type { VendorReliabilitySnapshot } from '@/lib/vendor-reliability-scorecard'
import type { AggregatedMaterialRequirement } from '@/lib/procurement-mrp-service'

/** Normalized board + GSM — ties paper warehouse rows to MRP buckets (grain not in warehouse). */
export function reorderRadarBoardGsmKey(boardType: string, gsm: number): string {
  const n = normalizeBoardKey(boardType)
  return `${n}|${gsm}`
}

export type ReorderRadarSnapshot = {
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

export function computeReorderRadarForRow(params: {
  boardType: string
  gsm: number
  radarKey: string
  totalSheetsDemand: number
  physicalByBoardGsm: Map<string, number>
  allocatedByBoardGsm: Map<string, number>
  minimumThreshold: number
  maximumBuffer: number
}): ReorderRadarSnapshot {
  const boardGsmKey = reorderRadarBoardGsmKey(params.boardType, params.gsm)
  const physicalSheets = params.physicalByBoardGsm.get(boardGsmKey) ?? 0
  const allocatedSheets = params.allocatedByBoardGsm.get(boardGsmKey) ?? 0
  const netAvailable = physicalSheets - allocatedSheets
  const min = Math.max(0, params.minimumThreshold)
  const max = Math.max(0, params.maximumBuffer)

  const isProcurementRisk = (min > 0 && netAvailable <= min) || netAvailable <= 0

  let stockStatus: 'OK' | 'Low_Stock_Alert' = 'OK'
  if (netAvailable <= 0 || (min > 0 && netAvailable <= min)) {
    stockStatus = 'Low_Stock_Alert'
  }

  let safetyStatus: ReorderRadarSnapshot['safetyStatus']
  if (netAvailable <= 0) {
    safetyStatus = 'stockout'
  } else if (min > 0 && netAvailable <= min * 1.2) {
    safetyStatus = 'low'
  } else if (min > 0 && netAvailable > min * 1.2) {
    safetyStatus = 'healthy'
  } else {
    safetyStatus = netAvailable > 0 ? 'healthy' : 'stockout'
  }

  let recommendedReorderSheets = 0
  if (max > 0) {
    recommendedReorderSheets = Math.max(0, max - netAvailable)
  } else if (min > 0) {
    recommendedReorderSheets = Math.max(0, min + Math.ceil(params.totalSheetsDemand * 0.1) - netAvailable)
  } else {
    recommendedReorderSheets = Math.max(0, Math.ceil(params.totalSheetsDemand * 0.2) - netAvailable)
  }

  return {
    boardGsmKey,
    physicalSheets,
    allocatedSheets,
    netAvailable,
    minimumThreshold: min,
    maximumBuffer: max,
    stockStatus,
    safetyStatus,
    recommendedReorderSheets,
    isProcurementRisk,
  }
}

export async function aggregatePhysicalPaperByBoardGsm(
  db: Pick<PrismaClient, 'paperWarehouse'>,
): Promise<Map<string, number>> {
  const rows = await db.paperWarehouse.findMany({
    where: { qtySheets: { gt: 0 } },
    select: { boardGrade: true, paperType: true, gsm: true, qtySheets: true },
  })
  const map = new Map<string, number>()
  for (const row of rows) {
    const label = (row.boardGrade?.trim() || row.paperType || '').trim()
    if (!label) continue
    const k = reorderRadarBoardGsmKey(label, row.gsm)
    map.set(k, (map.get(k) ?? 0) + row.qtySheets)
  }
  return map
}

export function aggregateAllocatedSheetsByBoardGsm(
  requirements: Pick<AggregatedMaterialRequirement, 'boardType' | 'gsm' | 'totalSheets'>[],
): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of requirements) {
    const k = reorderRadarBoardGsmKey(r.boardType, r.gsm)
    map.set(k, (map.get(k) ?? 0) + r.totalSheets)
  }
  return map
}

export function safetyBufferAuditMessage(userDisplayName: string): string {
  const u = userDisplayName.trim() || 'User'
  return `Safety Buffer Modified by ${u}.`
}

/** Elite = grade A on reliability scorecard; tie-break by composite score. */
export function pickEliteBoardSupplier(
  suppliers: Supplier[],
  scores: Map<string, VendorReliabilitySnapshot>,
): Supplier | null {
  const board = suppliers.filter(
    (s) =>
      s.active &&
      Array.isArray(s.materialTypes) &&
      s.materialTypes.some((t) => String(t).toLowerCase().includes('board')),
  )
  if (board.length === 0) return null
  const ranked = board
    .map((s) => ({ s, snap: scores.get(s.id) }))
    .filter((x): x is { s: Supplier; snap: VendorReliabilitySnapshot } => !!x.snap)
    .sort((a, b) => {
      const aElite = a.snap.grade === 'A' ? 1 : 0
      const bElite = b.snap.grade === 'A' ? 1 : 0
      if (aElite !== bElite) return bElite - aElite
      return b.snap.compositeScore - a.snap.compositeScore
    })
  if (ranked.length > 0) return ranked[0]!.s
  return [...board].sort((a, b) => a.name.localeCompare(b.name))[0] ?? null
}

export async function resolveBenchmarkRatePerKg(
  db: PrismaClient,
  boardGrade: string,
  gsm: number,
): Promise<number | null> {
  const bench = await computeMarketBenchmark30d(db, boardGrade, gsm)
  if (bench != null && bench.ratePerKg > 0) return bench.ratePerKg

  const norm = normalizeBoardKey(boardGrade)
  if (!norm || !Number.isFinite(gsm) || gsm <= 0) return null

  const lines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: {
      gsm,
      ratePerKg: { not: null, gt: 0 },
      vendorPo: { dispatchedAt: { not: null } },
    },
    orderBy: { vendorPo: { dispatchedAt: 'desc' } },
    take: 12,
    select: {
      boardGrade: true,
      ratePerKg: true,
    },
  })
  const hit = lines.find((ln) => boardGradesMatch(ln.boardGrade, norm))
  const r = hit?.ratePerKg != null ? Number(hit.ratePerKg) : null
  return r != null && Number.isFinite(r) && r > 0 ? r : null
}
