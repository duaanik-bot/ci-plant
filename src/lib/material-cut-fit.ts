type CutFitInput = {
  parentLength: number
  parentWidth: number
  reqLength: number
  reqWidth: number
}

export type MaterialCutFitOptionInput = {
  materialId: string
  materialCode: string
  boardType: string | null
  boardClassification: string | null
  gsm: number | null
  availableParentSheets: number
  reservedParentSheets?: number
  parentLength: number
  parentWidth: number
}

export type MaterialCutFitOption = {
  materialId: string
  materialCode: string
  boardType: string | null
  boardClassification: string | null
  gsm: number | null
  size: string
  availableSheets: number
  reservedSheets: number
  freeSheets: number
  cutsPerSheet: number
  requiredParentSheets: number
  shortageParentSheets: number
  wastagePct: number
  yieldPct: number
  orientation: 'LxW' | 'WxL'
  matchType: 'Cut Fit' | 'Direct Size' | 'Special Cut' | 'GSM Tolerance'
  status: 'Ready' | 'Partial' | 'Shortage'
  tags: Array<'Best Yield' | 'Least Wastage' | 'Closest GSM' | 'Most Available'>
  gsmDelta: number | null
}

export type MaterialCutFitConfig = {
  gsmTolerance: number
  allowRotation: boolean
  maxSuggestions: number
  directSizeTolerancePct: number
}

const DEFAULT_CONFIG: MaterialCutFitConfig = {
  gsmTolerance: 10,
  allowRotation: true,
  maxSuggestions: 10,
  directSizeTolerancePct: 20,
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

function formatDim(value: number): string {
  if (!Number.isFinite(value)) return '-'
  return value.toString()
}

export function calculateCutsPerSheet(input: CutFitInput): number {
  const parentLength = n(input.parentLength)
  const parentWidth = n(input.parentWidth)
  const reqLength = n(input.reqLength)
  const reqWidth = n(input.reqWidth)
  if (parentLength <= 0 || parentWidth <= 0 || reqLength <= 0 || reqWidth <= 0) return 0

  const optionA = Math.floor(parentLength / reqLength) * Math.floor(parentWidth / reqWidth)
  const optionB = Math.floor(parentLength / reqWidth) * Math.floor(parentWidth / reqLength)
  return Math.max(optionA, optionB, 0)
}

function calculateBestCutsWithOrientation(input: CutFitInput, allowRotation: boolean): { cuts: number; orientation: 'LxW' | 'WxL' } {
  const parentLength = n(input.parentLength)
  const parentWidth = n(input.parentWidth)
  const reqLength = n(input.reqLength)
  const reqWidth = n(input.reqWidth)
  if (parentLength <= 0 || parentWidth <= 0 || reqLength <= 0 || reqWidth <= 0) {
    return { cuts: 0, orientation: 'LxW' }
  }
  const cutsA = Math.floor(parentLength / reqLength) * Math.floor(parentWidth / reqWidth)
  if (!allowRotation) return { cuts: Math.max(0, cutsA), orientation: 'LxW' }
  const cutsB = Math.floor(parentLength / reqWidth) * Math.floor(parentWidth / reqLength)
  if (cutsB > cutsA) return { cuts: Math.max(0, cutsB), orientation: 'WxL' }
  return { cuts: Math.max(0, cutsA), orientation: 'LxW' }
}

export function buildMaterialCutFitOptions(input: {
  requiredLength: number
  requiredWidth: number
  requiredFinalSheets: number
  requiredGsm: number | null
  config?: Partial<MaterialCutFitConfig>
  materials: MaterialCutFitOptionInput[]
}): MaterialCutFitOption[] {
  const reqLength = n(input.requiredLength)
  const reqWidth = n(input.requiredWidth)
  const requiredFinalSheets = Math.max(1, Math.ceil(n(input.requiredFinalSheets)))
  const requiredGsm = input.requiredGsm == null ? null : n(input.requiredGsm)
  const config: MaterialCutFitConfig = {
    gsmTolerance: Math.max(0, n(input.config?.gsmTolerance ?? DEFAULT_CONFIG.gsmTolerance)),
    allowRotation: input.config?.allowRotation ?? DEFAULT_CONFIG.allowRotation,
    maxSuggestions: Math.max(1, Math.floor(n(input.config?.maxSuggestions ?? DEFAULT_CONFIG.maxSuggestions))),
    directSizeTolerancePct: Math.max(0, n(input.config?.directSizeTolerancePct ?? DEFAULT_CONFIG.directSizeTolerancePct)),
  }
  if (reqLength <= 0 || reqWidth <= 0) return []

  const seenMaterialIds = new Set<string>()
  const options: MaterialCutFitOption[] = []
  for (const m of input.materials) {
    if (!m.materialId || seenMaterialIds.has(m.materialId)) continue
    seenMaterialIds.add(m.materialId)
    const parentLength = n(m.parentLength)
    const parentWidth = n(m.parentWidth)
    const best = calculateBestCutsWithOrientation(
      {
        parentLength,
        parentWidth,
        reqLength,
        reqWidth,
      },
      config.allowRotation,
    )
    const toleranceLength = (reqLength * config.directSizeTolerancePct) / 100
    const toleranceWidth = (reqWidth * config.directSizeTolerancePct) / 100
    const sameSizeExact =
      (Math.abs(parentLength - reqLength) < 0.0001 && Math.abs(parentWidth - reqWidth) < 0.0001) ||
      (Math.abs(parentLength - reqWidth) < 0.0001 && Math.abs(parentWidth - reqLength) < 0.0001)
    const withinTolerance =
      (Math.abs(parentLength - reqLength) <= toleranceLength &&
        Math.abs(parentWidth - reqWidth) <= toleranceWidth) ||
      (Math.abs(parentLength - reqWidth) <= toleranceWidth &&
        Math.abs(parentWidth - reqLength) <= toleranceLength)

    const directMode: 'none' | 'direct_size' | 'special_cut' = sameSizeExact
      ? 'direct_size'
      : withinTolerance
        ? 'special_cut'
        : 'none'

    const cutsPerSheet = directMode === 'none' ? best.cuts : 1
    if (cutsPerSheet <= 0) continue

    const gsm = m.gsm == null ? null : n(m.gsm)
    const gsmDelta = requiredGsm == null || gsm == null ? null : Math.abs(gsm - requiredGsm)
    const gsmExact = gsmDelta != null && gsmDelta === 0
    const gsmWithinTolerance = gsmDelta != null && gsmDelta <= config.gsmTolerance
    if (requiredGsm != null && !(gsmExact || gsmWithinTolerance)) continue

    const parentArea = parentLength * parentWidth
    const usedArea = cutsPerSheet * reqLength * reqWidth
    const yieldPct = parentArea > 0 ? (usedArea / parentArea) * 100 : 0
    const wastagePct = Math.max(0, 100 - yieldPct)
    const requiredParentSheets = Math.max(1, Math.ceil(requiredFinalSheets / cutsPerSheet))
    const availableSheets = Math.max(0, n(m.availableParentSheets))
    const reservedSheets = Math.max(0, n(m.reservedParentSheets))
    const freeSheets = availableSheets - reservedSheets
    const reservableSheets = Math.max(0, freeSheets)
    const shortageParentSheets = Math.max(0, requiredParentSheets - reservableSheets)
    const status: 'Ready' | 'Partial' | 'Shortage' =
      reservableSheets >= requiredParentSheets ? 'Ready' : reservableSheets > 0 ? 'Partial' : 'Shortage'

    const matchType: 'Cut Fit' | 'Direct Size' | 'Special Cut' | 'GSM Tolerance' =
      !gsmExact && gsmWithinTolerance
        ? 'GSM Tolerance'
        : directMode === 'direct_size'
          ? 'Direct Size'
          : directMode === 'special_cut'
            ? 'Special Cut'
            : 'Cut Fit'

    options.push({
      materialId: m.materialId,
      materialCode: m.materialCode || '-',
      boardType: m.boardType ?? null,
      boardClassification: m.boardClassification ?? null,
      gsm: m.gsm ?? null,
      size: `${formatDim(parentLength)} x ${formatDim(parentWidth)}`,
      availableSheets,
      reservedSheets,
      freeSheets,
      cutsPerSheet,
      requiredParentSheets,
      shortageParentSheets,
      wastagePct: Number(wastagePct.toFixed(2)),
      yieldPct: Number(yieldPct.toFixed(2)),
      orientation: directMode === 'none' ? best.orientation : 'LxW',
      matchType,
      status,
      tags: [],
      gsmDelta,
    })
  }

  options.sort((a, b) => {
    if (a.wastagePct !== b.wastagePct) return a.wastagePct - b.wastagePct
    if (b.cutsPerSheet !== a.cutsPerSheet) return b.cutsPerSheet - a.cutsPerSheet
    const aExact = a.gsmDelta === 0 ? 1 : 0
    const bExact = b.gsmDelta === 0 ? 1 : 0
    if (bExact !== aExact) return bExact - aExact
    if (b.availableSheets !== a.availableSheets) return b.availableSheets - a.availableSheets
    return a.materialCode.localeCompare(b.materialCode)
  })

  const limited = options.slice(0, config.maxSuggestions)
  if (limited.length > 0) {
    const bestYield = Math.max(...limited.map((o) => o.yieldPct))
    const leastWastage = Math.min(...limited.map((o) => o.wastagePct))
    const minGsmDelta = Math.min(...limited.map((o) => (o.gsmDelta == null ? Number.MAX_SAFE_INTEGER : o.gsmDelta)))
    const mostAvailable = Math.max(...limited.map((o) => o.availableSheets))
    limited.forEach((o) => {
      if (o.yieldPct === bestYield) o.tags.push('Best Yield')
      if (o.wastagePct === leastWastage) o.tags.push('Least Wastage')
      if (o.gsmDelta != null && o.gsmDelta === minGsmDelta) o.tags.push('Closest GSM')
      if (o.availableSheets === mostAvailable) o.tags.push('Most Available')
    })
  }

  return limited
}
