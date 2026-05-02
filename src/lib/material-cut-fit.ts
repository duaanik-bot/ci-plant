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
  cutsPerSheet: number
  requiredParentSheets: number
  shortageParentSheets: number
  wastagePct: number
  yieldPct: number
  orientation: 'LxW' | 'WxL'
  matchType: 'Exact' | 'Size Fit' | 'GSM Tolerance'
  status: 'Ready' | 'Partial' | 'Shortage'
  tags: Array<'Best Yield' | 'Least Wastage' | 'Closest GSM' | 'Most Available'>
  gsmDelta: number | null
}

export type MaterialCutFitConfig = {
  gsmTolerance: number
  allowRotation: boolean
  maxSuggestions: number
}

const DEFAULT_CONFIG: MaterialCutFitConfig = {
  gsmTolerance: 10,
  allowRotation: true,
  maxSuggestions: 10,
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
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
    const cutsPerSheet = best.cuts
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
    const shortageParentSheets = Math.max(0, requiredParentSheets - availableSheets)
    const status: 'Ready' | 'Partial' | 'Shortage' =
      shortageParentSheets <= 0 ? 'Ready' : availableSheets > 0 ? 'Partial' : 'Shortage'

    const sameSize =
      (Math.abs(parentLength - reqLength) < 0.0001 && Math.abs(parentWidth - reqWidth) < 0.0001) ||
      (Math.abs(parentLength - reqWidth) < 0.0001 && Math.abs(parentWidth - reqLength) < 0.0001)
    const matchType: 'Exact' | 'Size Fit' | 'GSM Tolerance' =
      sameSize && gsmExact ? 'Exact' : gsmExact ? 'Size Fit' : 'GSM Tolerance'

    options.push({
      materialId: m.materialId,
      materialCode: m.materialCode || '-',
      boardType: m.boardType ?? null,
      boardClassification: m.boardClassification ?? null,
      gsm: m.gsm ?? null,
      size: `${Math.round(parentLength)} x ${Math.round(parentWidth)}`,
      availableSheets,
      cutsPerSheet,
      requiredParentSheets,
      shortageParentSheets,
      wastagePct: Number(wastagePct.toFixed(2)),
      yieldPct: Number(yieldPct.toFixed(2)),
      orientation: best.orientation,
      matchType,
      status,
      tags: [],
      gsmDelta,
    })
  }

  options.sort((a, b) => {
    if (b.cutsPerSheet !== a.cutsPerSheet) return b.cutsPerSheet - a.cutsPerSheet
    if (a.wastagePct !== b.wastagePct) return a.wastagePct - b.wastagePct
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
