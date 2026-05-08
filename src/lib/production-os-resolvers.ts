import { parseSheetSizeToPair, resolveSheetSize as resolveSheetSizeLegacy } from '@/lib/planning-sheet-size'

type Dict = Record<string, unknown>

function asDict(v: unknown): Dict {
  return v && typeof v === 'object' ? (v as Dict) : {}
}

function asText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

function asNum(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function asPositiveNum(v: unknown): number | null {
  const n = asNum(v)
  return n != null && n > 0 ? n : null
}

export function resolveSheetSize(line: unknown): string {
  const d = asDict(line)
  const awItem = asDict((d as Dict).awItem)
  const planningLine = asDict((d as Dict).planningLine)
  const poLine = asDict((d as Dict).poLine)
  const spec = asDict(d.spec)
  const specOverrides = asDict(d.specOverrides)
  const nestedSpec = asDict(spec.spec)
  const nestedOverridesSpec = asDict(specOverrides.spec)
  const planningSpec = asDict(planningLine.spec)
  const planningOverrides = asDict(planningLine.specOverrides)
  const planningCore = asDict(planningOverrides.planningCore)
  const poSpec = asDict(poLine.spec)
  const poOverrides = asDict(poLine.specOverrides)
  const candidates: unknown[] = [
    d.sheetSize,
    d.actualSheetSize,
    awItem.sheetSize,
    awItem.actualSheetSize,
    planningLine.sheetSize,
    planningLine.actualSheetSize,
    planningOverrides.sheetSize,
    planningOverrides.actualSheetSize,
    planningCore.sheetSize,
    planningCore.actualSheetSize,
    planningSpec.sheetSize,
    planningSpec.actualSheetSize,
    poLine.sheetSize,
    poLine.actualSheetSize,
    poOverrides.sheetSize,
    poOverrides.actualSheetSize,
    poSpec.sheetSize,
    poSpec.actualSheetSize,
    specOverrides.sheetSize,
    specOverrides.actualSheetSize,
    spec.sheetSize,
    spec.actualSheetSize,
    nestedSpec.sheetSize,
    nestedSpec.actualSheetSize,
    nestedOverridesSpec.sheetSize,
    nestedOverridesSpec.actualSheetSize,
    asDict(d.carton).sheetSize,
    asDict(d.product).sheetSize,
  ]
  for (const c of candidates) {
    const t = asText(c)
    if (t) return t
  }
  const carton = asDict(d.carton)
  const product = asDict(d.product)
  const blankLength = asPositiveNum(carton.blankLength ?? product.blankLength)
  const blankWidth = asPositiveNum(carton.blankWidth ?? product.blankWidth)
  if (blankLength != null && blankWidth != null) return `${blankLength}x${blankWidth}`
  return resolveSheetSizeLegacy(asDict(line))
}

export function resolveUps(line: unknown): number | null {
  const d = asDict(line)
  const specOverrides = asDict(d.specOverrides)
  const spec = asDict(d.spec)
  const specOverridesMeta = asDict(specOverrides.meta)
  const specMeta = asDict(spec.meta)
  const planningCore = asDict(specOverrides.planningCore)
  const product = asDict(d.product)
  const carton = asDict(d.carton)
  const productMaster = asDict((d as Dict).productMaster)
  const master = asDict((d as Dict).master)
  const candidates: unknown[] = [
    d.ups,
    specOverrides.ups,
    specOverridesMeta.ups,
    planningCore.upsPerSheet,
    planningCore.ups,
    spec.ups,
    specMeta.ups,
    product.ups,
    carton.ups,
    productMaster.ups,
    master.ups,
  ]
  for (const c of candidates) {
    const n = asPositiveNum(c)
    if (n != null) return Math.max(1, Math.floor(n))
  }
  return null
}

export function resolveMaterial(payload: {
  selectedMaterialId?: string | null
  requirementMaterialId?: string | null
  autoMaterialId?: string | null
}) {
  const materialId =
    asText(payload.selectedMaterialId) ||
    asText(payload.requirementMaterialId) ||
    asText(payload.autoMaterialId) ||
    null
  return { materialId }
}

export function resolveReservationState(input: {
  requiredSheets: number
  availableSheets: number
  reservedSheets: number
}) {
  const required = Math.max(0, Number(input.requiredSheets) || 0)
  const available = Math.max(0, Number(input.availableSheets) || 0)
  const reserved = Math.max(0, Number(input.reservedSheets) || 0)
  const freeStock = available - reserved
  const reservable = Math.max(0, freeStock)
  const reserveQty = Math.min(required, reservable)
  return {
    requiredSheets: required,
    availableSheets: available,
    reservedSheets: reserved,
    freeStock,
    reservable,
    reserveQty,
  }
}

export function resolveShortageState(input: {
  requiredSheets: number
  reserveQty?: number
  shortageSheets?: number
}) {
  const required = Math.max(0, Number(input.requiredSheets) || 0)
  if (input.shortageSheets != null) {
    return { shortageSheets: Math.max(0, Number(input.shortageSheets) || 0) }
  }
  const reserve = Math.max(0, Number(input.reserveQty) || 0)
  return { shortageSheets: Math.max(0, required - reserve) }
}

export function resolvePrState(input: {
  prStatus?: string | null
  prId?: string | null
  shortageSheets?: number
}) {
  const status = (asText(input.prStatus) || 'not_created').toLowerCase()
  if (asText(input.prId)) return { prState: status, prExists: true }
  if ((Number(input.shortageSheets) || 0) > 0 && status === 'not_created') {
    return { prState: 'pending_creation', prExists: false }
  }
  return { prState: status, prExists: status !== 'not_created' }
}

export function resolveCuts(input: {
  parentLength: number
  parentWidth: number
  reqLength: number
  reqWidth: number
  allowRotation?: boolean
  directSize?: boolean
}): { cutsPerSheet: number; orientation: 'LxW' | 'WxL' } {
  if (input.directSize) return { cutsPerSheet: 1, orientation: 'LxW' }
  const pl = Math.max(0, Number(input.parentLength) || 0)
  const pw = Math.max(0, Number(input.parentWidth) || 0)
  const rl = Math.max(0, Number(input.reqLength) || 0)
  const rw = Math.max(0, Number(input.reqWidth) || 0)
  if (!pl || !pw || !rl || !rw) return { cutsPerSheet: 0, orientation: 'LxW' }
  const normal = Math.floor(pl / rl) * Math.floor(pw / rw)
  const rotated = Math.floor(pl / rw) * Math.floor(pw / rl)
  if (input.allowRotation === false || normal >= rotated) return { cutsPerSheet: Math.max(0, normal), orientation: 'LxW' }
  return { cutsPerSheet: Math.max(0, rotated), orientation: 'WxL' }
}

export function resolveWastage(input: {
  parentLength: number
  parentWidth: number
  reqLength: number
  reqWidth: number
  cutsPerSheet: number
}) {
  const pl = Math.max(0, Number(input.parentLength) || 0)
  const pw = Math.max(0, Number(input.parentWidth) || 0)
  const rl = Math.max(0, Number(input.reqLength) || 0)
  const rw = Math.max(0, Number(input.reqWidth) || 0)
  const cuts = Math.max(0, Number(input.cutsPerSheet) || 0)
  const parentArea = pl * pw
  const usedArea = rl * rw * cuts
  const sizeDiff = Math.abs(parentArea - usedArea)
  const utilizationPct = parentArea > 0 ? (usedArea / parentArea) * 100 : 0
  const wastagePct = Math.max(0, Math.min(100, 100 - utilizationPct))
  const sizeDeviationPct = parentArea > 0 ? (sizeDiff / parentArea) * 100 : 100
  return {
    parentArea,
    usedArea,
    sizeDiff,
    utilizationPct: Number(utilizationPct.toFixed(2)),
    wastagePct: Number(wastagePct.toFixed(2)),
    sizeDeviationPct: Number(sizeDeviationPct.toFixed(2)),
  }
}

export function resolveFitScore(input: {
  isExactSize: boolean
  isNearSize: boolean
  isExactGsm: boolean
  isGsmTolerance: boolean
  gsmDelta: number | null
  gsmTolerance: number
  wastagePct: number
  sizeDeviationPct: number
  cutsPerSheet: number
  isLeftover: boolean
}) {
  const sizeFit = input.isExactSize ? 100 : input.isNearSize ? 80 : Math.max(0, 100 - input.sizeDeviationPct)
  const gsmFit =
    input.isExactGsm
      ? 100
      : input.isGsmTolerance
        ? Math.max(0, 100 - ((input.gsmDelta || 0) / Math.max(1, input.gsmTolerance)) * 100)
        : 0
  const lowWastage = Math.max(0, 100 - Math.max(0, input.wastagePct))
  const cutsEff = Math.max(0, Math.min(100, input.cutsPerSheet * 20))
  const leftoverReuse = input.isLeftover ? 100 : 0
  const score = sizeFit * 0.3 + gsmFit * 0.2 + lowWastage * 0.2 + (100 - input.sizeDeviationPct) * 0.1 + cutsEff * 0.1 + leftoverReuse * 0.05 + 5 // aging bonus placeholder
  return Number(Math.max(0, Math.min(100, score)).toFixed(2))
}

export function resolveLeftover(input: {
  materialCode?: string | null
  attributes?: unknown
  sourceTraceability?: string | null
}) {
  const code = asText(input.materialCode) || ''
  const byCode = code.toUpperCase().startsWith('LEFTOVER-')
  let meta: Dict = {}
  if (typeof input.attributes === 'string' && input.attributes.trim()) {
    try {
      meta = JSON.parse(input.attributes) as Dict
    } catch {
      meta = {}
    }
  } else if (input.attributes && typeof input.attributes === 'object') {
    meta = input.attributes as Dict
  }
  const byAttr = meta.leftover === true
  return {
    isLeftover: byCode || byAttr,
    sourceTraceability: asText(input.sourceTraceability) || asText(meta.traceability) || null,
  }
}

export function resolveInventoryHealth(input: {
  shortageSheets: number
  freeStock: number
  ageDays?: number | null
  isLeftover?: boolean
  isRestricted?: boolean
  isDamaged?: boolean
}) {
  if (input.isDamaged) return 'Damaged'
  if (input.isRestricted) return 'Restricted'
  if (input.isLeftover) return 'Leftover'
  const shortage = Math.max(0, Number(input.shortageSheets) || 0)
  const free = Number(input.freeStock) || 0
  const age = Number(input.ageDays) || 0
  if (shortage > 0 || free < 0) return 'Stale'
  if (age > 180) return 'Aging'
  if (age > 90) return 'Healthy'
  return 'Fresh'
}

export function resolveBoardReadiness(input: {
  materialSelected: boolean
  requiredSheets: number
  availableSheets: number
  reservedSheets: number
  shortageSheets?: number
}) {
  if (!input.materialSelected) return 'No Material' as const
  const reservation = resolveReservationState(input)
  const shortage = resolveShortageState({
    requiredSheets: reservation.requiredSheets,
    reserveQty: reservation.reserveQty,
    shortageSheets: input.shortageSheets,
  }).shortageSheets
  if (reservation.reservable >= reservation.requiredSheets && shortage <= 0) return 'Ready' as const
  if (reservation.reservable > 0 || shortage > 0) return 'Partial' as const
  return 'Shortage' as const
}

export function resolveRequirementFromLine(input: {
  line: unknown
  qtyOverride?: number | null
  upsOverride?: number | null
  wastageOverride?: number | null
}) {
  const line = asDict(input.line)
  const specOverrides = asDict(line.specOverrides)
  const spec = asDict(line.spec)
  const qty = Math.max(1, Math.floor(Number(input.qtyOverride ?? line.quantity ?? 1) || 1))
  const ups = Math.max(1, Math.floor(Number(input.upsOverride ?? resolveUps(line) ?? specOverrides.ups ?? spec.ups ?? 1) || 1))
  const wastage = Math.max(0, Math.floor(Number(input.wastageOverride ?? specOverrides.wastageSheets ?? spec.wastageSheets ?? 150) || 0))
  const baseSheets = Math.max(1, Math.ceil(qty / ups))
  return {
    qty,
    ups,
    wastageSheets: wastage,
    baseSheets,
    requiredSheets: Math.max(1, baseSheets + wastage),
    sheetSize: resolveSheetSize(line),
    sheetSizePair: parseSheetSizeToPair(resolveSheetSize(line)),
  }
}
