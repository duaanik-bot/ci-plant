import type { Dye, MaterialQueue, PoLineItem, PurchaseOrder, Supplier } from '@prisma/client'
import {
  calculateBoardRequirement,
  kgToMetricTons,
  parseSheetSizeToMm,
  type BoardMrpResult,
} from '@/lib/board-mrp'
import { addCalendarDaysYmd, parseDeliveryYmdFromRemarks } from '@/lib/po-delivery-parse'

export const PROCUREMENT_DEFAULT_SIGNATORY = 'Anik Dua'

export type MrpLineContribution = {
  poLineItemId: string
  poId: string
  poNumber: string
  customerName: string
  cartonName: string
  quantity: number
  sheets: number
  weightKg: number
  /** Production job card # when allocated; else null (use line id for traceability). */
  jobCardNumber: number | null
  customerDeliveryYmd: string | null
  vendorRequiredDeliveryYmd: string | null
  /** Customer PO line board procurement state. */
  materialProcurementStatus: string
}

export type MaterialReadinessRollup =
  | 'planned'
  | 'ordered'
  | 'in_transit'
  | 'received'
  | 'mixed'

export type AggregatedMaterialRequirement = {
  key: string
  boardType: string
  gsm: number
  grainDirection: string
  /** e.g. `787×546 mm` from material queue sheet dimensions. */
  sheetSizeLabel: string
  totalSheets: number
  totalWeightKg: number
  totalMetricTons: number
  contributions: MrpLineContribution[]
  suggestedSupplierId: string | null
  suggestedSupplierName: string | null
  /** Earliest `material_queue.calculated_at` in this bucket (ISO). */
  oldestCalculatedAt: string
  /** Starred PO or director line priority on any contributing line. */
  industrialPriority: boolean
  /** Rolled up from contributing line `materialProcurementStatus` values. */
  readinessRollup: MaterialReadinessRollup
}

type SpecJson = Record<string, unknown> | null

function specNum(spec: SpecJson, k: string): number | undefined {
  if (!spec || typeof spec !== 'object') return undefined
  const v = spec[k]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function specStr(spec: SpecJson, k: string): string | undefined {
  if (!spec || typeof spec !== 'object') return undefined
  const v = spec[k]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function customerDeliveryYmd(po: PurchaseOrder): string | null {
  if (po.deliveryRequiredBy) {
    return po.deliveryRequiredBy.toISOString().slice(0, 10)
  }
  return parseDeliveryYmdFromRemarks(po.remarks)
}

export function requirementAggregationKey(boardType: string, gsm: number, grainDirection: string): string {
  return `${boardType}|${gsm}|${grainDirection}`
}

export type LineMrpCompute =
  | {
      ok: true
      key: string
      boardType: string
      gsm: number
      grainDirection: string
      mrp: BoardMrpResult
      sheetLengthMm: number
      sheetWidthMm: number
      ups: number
      wastagePct: number
    }
  | { ok: false; reason: string }

export function computeLineBoardMrp(
  line: PoLineItem,
  die: Pick<Dye, 'sheetSize' | 'ups'> | null,
): LineMrpCompute {
  const spec = line.specOverrides as SpecJson
  const boardType = specStr(spec, 'boardGrade')?.trim() || 'Unknown'
  const gsm = line.gsm ?? specNum(spec, 'gsm')
  if (gsm == null || gsm <= 0) {
    return { ok: false, reason: 'GSM missing' }
  }
  const sheetRaw = die?.sheetSize?.trim() || null
  const dims = parseSheetSizeToMm(sheetRaw)
  if (!dims) {
    return { ok: false, reason: 'Sheet size missing (link die with sheet size)' }
  }
  const ups = specNum(spec, 'ups') ?? die?.ups ?? 1
  const wastagePct = specNum(spec, 'wastagePct') ?? 10
  const grainDirection = specStr(spec, 'grainDirection') || 'Long grain'
  const upsInt = Math.max(1, Math.round(ups))
  const mrp = calculateBoardRequirement({
    sheetLengthMm: dims.lMm,
    sheetWidthMm: dims.wMm,
    gsm: Math.round(gsm),
    ups: upsInt,
    customerQty: line.quantity,
    wastagePct,
  })
  const key = requirementAggregationKey(boardType, Math.round(gsm), grainDirection)
  return {
    ok: true,
    key,
    boardType,
    gsm: Math.round(gsm),
    grainDirection,
    mrp,
    sheetLengthMm: dims.lMm,
    sheetWidthMm: dims.wMm,
    ups: upsInt,
    wastagePct,
  }
}

export function pickSuggestedBoardSupplier(suppliers: Supplier[]): Supplier | null {
  const board = suppliers.filter(
    (s) =>
      s.active &&
      Array.isArray(s.materialTypes) &&
      s.materialTypes.some((t) => String(t).toLowerCase().includes('board')),
  )
  if (board.length === 0) return null
  return [...board].sort((a, b) => a.name.localeCompare(b.name))[0] ?? null
}

/** Prefer supplier whose defaultForBoardGrades matches board type (e.g. FBB, SBS). */
export function pickSupplierForBoardType(boardType: string, suppliers: Supplier[]): Supplier | null {
  const norm = boardType.trim().toLowerCase()
  const boardSuppliers = suppliers.filter(
    (s) =>
      s.active &&
      Array.isArray(s.materialTypes) &&
      s.materialTypes.some((t) => String(t).toLowerCase().includes('board')),
  )
  const grades = (s: Supplier) =>
    Array.isArray(s.defaultForBoardGrades) ? s.defaultForBoardGrades : []
  const exact = boardSuppliers.find((s) =>
    grades(s).some((g) => g.trim().toLowerCase() === norm),
  )
  if (exact) return exact
  const partial = boardSuppliers.find((s) =>
    grades(s).some(
      (g) =>
        norm.includes(g.trim().toLowerCase()) || g.trim().toLowerCase().includes(norm),
    ),
  )
  if (partial) return partial
  return pickSuggestedBoardSupplier(suppliers)
}

export function aggregateContributions(
  rows: {
    line: PoLineItem
    po: PurchaseOrder & { customer: { name: string } }
    die: Pick<Dye, 'sheetSize' | 'ups'> | null
  }[],
  suppliers: Supplier[],
): AggregatedMaterialRequirement[] {
  const suggested = pickSuggestedBoardSupplier(suppliers)
  const map = new Map<
    string,
    {
      boardType: string
      gsm: number
      grainDirection: string
      totalSheets: number
      totalWeightKg: number
      contributions: MrpLineContribution[]
      oldestLineCreatedAt: Date
      industrialPriority: boolean
    }
  >()

  for (const { line, po, die } of rows) {
    const computed = computeLineBoardMrp(line, die)
    if (!computed.ok) continue
    const linePri = line.directorPriority === true || po.isPriority === true
    const custDel = customerDeliveryYmd(po)
    const vendorDel = custDel ? addCalendarDaysYmd(custDel, -5) : null
    const contrib: MrpLineContribution = {
      poLineItemId: line.id,
      poId: po.id,
      poNumber: po.poNumber,
      customerName: po.customer.name,
      cartonName: line.cartonName,
      quantity: line.quantity,
      sheets: computed.mrp.sheetsWithWastage,
      weightKg: computed.mrp.weightKg,
      jobCardNumber: line.jobCardNumber ?? null,
      customerDeliveryYmd: custDel,
      vendorRequiredDeliveryYmd: vendorDel,
      materialProcurementStatus: line.materialProcurementStatus,
    }
    const existing = map.get(computed.key)
    if (existing) {
      existing.totalSheets += contrib.sheets
      existing.totalWeightKg += contrib.weightKg
      existing.contributions.push(contrib)
      if (line.createdAt.getTime() < existing.oldestLineCreatedAt.getTime()) {
        existing.oldestLineCreatedAt = line.createdAt
      }
      existing.industrialPriority = existing.industrialPriority || linePri
    } else {
      map.set(computed.key, {
        boardType: computed.boardType,
        gsm: computed.gsm,
        grainDirection: computed.grainDirection,
        totalSheets: contrib.sheets,
        totalWeightKg: contrib.weightKg,
        contributions: [contrib],
        oldestLineCreatedAt: line.createdAt,
        industrialPriority: linePri,
      })
    }
  }

  return Array.from(map.entries()).map(([key, v]) => {
    const byBoard = pickSupplierForBoardType(v.boardType, suppliers)
    const sug = byBoard ?? suggested
    return {
      key,
      boardType: v.boardType,
      gsm: v.gsm,
      grainDirection: v.grainDirection,
      sheetSizeLabel: '—',
      totalSheets: v.totalSheets,
      totalWeightKg: v.totalWeightKg,
      totalMetricTons: kgToMetricTons(v.totalWeightKg),
      contributions: v.contributions,
      suggestedSupplierId: sug?.id ?? null,
      suggestedSupplierName: sug?.name ?? null,
      oldestCalculatedAt: v.oldestLineCreatedAt.toISOString(),
      industrialPriority: v.industrialPriority,
      readinessRollup: rollupMaterialReadiness(v.contributions.map((c) => c.materialProcurementStatus)),
    }
  })
}

const PROC_STAT = (s: string) => s.trim().toLowerCase()

/** Derive a single readiness lane from customer line procurement statuses. */
export function rollupMaterialReadiness(statuses: string[]): MaterialReadinessRollup {
  if (statuses.length === 0) return 'planned'
  const set = new Set(statuses.map(PROC_STAT))
  if (set.has('pending')) return 'planned'
  if (set.has('dispatched')) return 'in_transit'
  if (set.has('on_order') || set.has('paper_ordered')) {
    const onlyOrdered = Array.from(set).every((x) => x === 'on_order' || x === 'paper_ordered')
    if (onlyOrdered && set.size > 0) return 'ordered'
  }
  const arr = Array.from(set)
  const onlyReceived = arr.length > 0 && arr.every((x) => x === 'received')
  if (onlyReceived) return 'received'
  return 'mixed'
}

export function aggregateFromStoredRequirements(
  rows: {
    mr: MaterialQueue
    line: PoLineItem
    po: PurchaseOrder & { customer: { name: string } }
  }[],
  suppliers: Supplier[],
): AggregatedMaterialRequirement[] {
  const map = new Map<
    string,
    {
      boardType: string
      gsm: number
      grainDirection: string
      sheetSizeLabel: string
      totalSheets: number
      totalWeightKg: number
      contributions: MrpLineContribution[]
      oldestCalculatedAt: Date
      industrialPriority: boolean
    }
  >()

  for (const { mr, line, po } of rows) {
    const key = requirementAggregationKey(mr.boardType, mr.gsm, mr.grainDirection)
    const custDel = customerDeliveryYmd(po)
    const vendorDel = custDel ? addCalendarDaysYmd(custDel, -5) : null
    const sheets = mr.totalSheets
    const weightKg = Number(mr.totalWeightKg)
    const linePri = line.directorPriority === true || po.isPriority === true
    const lMm = Number(mr.sheetLengthMm)
    const wMm = Number(mr.sheetWidthMm)
    const sheetSizeLabel =
      Number.isFinite(lMm) && Number.isFinite(wMm) && lMm > 0 && wMm > 0
        ? `${Math.round(lMm)}×${Math.round(wMm)} mm`
        : '—'
    const contrib: MrpLineContribution = {
      poLineItemId: line.id,
      poId: po.id,
      poNumber: po.poNumber,
      customerName: po.customer.name,
      cartonName: line.cartonName,
      quantity: line.quantity,
      sheets,
      weightKg,
      jobCardNumber: line.jobCardNumber ?? null,
      customerDeliveryYmd: custDel,
      vendorRequiredDeliveryYmd: vendorDel,
      materialProcurementStatus: line.materialProcurementStatus,
    }
    const existing = map.get(key)
    if (existing) {
      existing.totalSheets += sheets
      existing.totalWeightKg += weightKg
      existing.contributions.push(contrib)
      if (mr.calculatedAt.getTime() < existing.oldestCalculatedAt.getTime()) {
        existing.oldestCalculatedAt = mr.calculatedAt
      }
      existing.industrialPriority = existing.industrialPriority || linePri
    } else {
      map.set(key, {
        boardType: mr.boardType,
        gsm: mr.gsm,
        grainDirection: mr.grainDirection,
        sheetSizeLabel,
        totalSheets: sheets,
        totalWeightKg: weightKg,
        contributions: [contrib],
        oldestCalculatedAt: mr.calculatedAt,
        industrialPriority: linePri,
      })
    }
  }

  const fallback = pickSuggestedBoardSupplier(suppliers)
  return Array.from(map.entries()).map(([key, v]) => {
    const byBoard = pickSupplierForBoardType(v.boardType, suppliers)
    const sug = byBoard ?? fallback
    return {
      key,
      boardType: v.boardType,
      gsm: v.gsm,
      grainDirection: v.grainDirection,
      sheetSizeLabel: v.sheetSizeLabel,
      totalSheets: v.totalSheets,
      totalWeightKg: v.totalWeightKg,
      totalMetricTons: kgToMetricTons(v.totalWeightKg),
      contributions: v.contributions,
      suggestedSupplierId: sug?.id ?? null,
      suggestedSupplierName: sug?.name ?? null,
      oldestCalculatedAt: v.oldestCalculatedAt.toISOString(),
      industrialPriority: v.industrialPriority,
      readinessRollup: rollupMaterialReadiness(v.contributions.map((c) => c.materialProcurementStatus)),
    }
  })
}
