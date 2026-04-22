import { computeSheetUtilization, readPlanningCore } from '@/lib/planning-decision-spec'
import { hasSpecialCoatingForPlanning } from '@/lib/planning-predictive'

/**
 * Heuristic auto-batching for Planning: groups compatible lines, then greedily forms batch candidates
 * with sheet/efficiency guardrails, and scores each suggestion.
 * Pure functions — no I/O. Tune constants with production feedback.
 */
export const SUGGEST_DEFAULTS = {
  /** Default parent sheet (mm) when only one dimension known */
  defaultSheetL: 1020,
  defaultSheetW: 720,
  /** Stop growing a batch if projected average yield (%) falls below this */
  minAverageYieldToContinue: 48,
  /** Soft cap: sum of per-line sheet estimates in one suggested batch */
  maxBatchSheetCount: 420,
  /** Hard cap: lines per batch */
  maxLinesPerBatch: 10,
  /** Minimum jobs in a suggested batch (mix-set needs ≥2) */
  minBatchSize: 2,
} as const

export type SuggestableLine = {
  id: string
  cartonName: string
  quantity: number
  coatingType: string | null
  otherCoating: string | null
  paperType: string | null
  gsm: number | null
  planningStatus: string
  specOverrides: Record<string, unknown> | null
  materialQueue: {
    boardType?: string | null
    gsm?: number | null
    ups?: number | null
    sheetLengthMm?: unknown
    sheetWidthMm?: unknown
  } | null
  carton: {
    blankLength?: unknown
    blankWidth?: unknown
    gsm?: number | null
    coatingType?: string | null
    laminateType?: string | null
    paperType?: string | null
    numberOfColours?: number | null
  } | null
  dimLengthMm?: unknown
  dimWidthMm?: unknown
  po: { poNumber: string; poDate: string; isPriority?: boolean; status?: string }
  directorHold?: boolean
  planningLedger?: { toolingInterlock: { allReady: boolean } } | null
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function norm(s: string | null | undefined): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
}

function boardKey(l: SuggestableLine): string {
  const mq = l.materialQueue
  return norm(mq?.boardType) || norm(l.paperType) || norm(l.carton?.paperType) || '—'
}

function gsmKey(l: SuggestableLine): string {
  const g = l.gsm ?? l.carton?.gsm ?? l.materialQueue?.gsm ?? null
  return g != null && Number.isFinite(Number(g)) ? String(Math.round(Number(g))) : '—'
}

function nColours(l: SuggestableLine): number {
  const spec = l.specOverrides || {}
  const n = spec && typeof spec === 'object' && typeof (spec as { numberOfColours?: number }).numberOfColours === 'number'
    ? (spec as { numberOfColours: number }).numberOfColours
    : null
  return Math.max(1, Math.min(8, Math.floor(n ?? l.carton?.numberOfColours ?? 4)))
}

function printingProcessKey(l: SuggestableLine): string {
  const c = l.coatingType || l.carton?.coatingType
  const o = l.otherCoating || l.carton?.laminateType
  const sp = hasSpecialCoatingForPlanning(c, o) ? '1' : '0'
  return `${nColours(l)}c_${sp}`
}

function coatingGroupKey(l: SuggestableLine): string {
  return `${norm(l.coatingType || l.carton?.coatingType)}|${norm(l.otherCoating || l.carton?.laminateType)}`
}

/** Jobs must share board, GSM, coating family, and printing bucket to sit in the same group. */
export function groupingKey(l: SuggestableLine): string {
  return [boardKey(l), gsmKey(l), coatingGroupKey(l), printingProcessKey(l)].join('::')
}

function effUps(l: SuggestableLine): number {
  const pc = readPlanningCore(l.specOverrides)
  const u = pc.ups ?? l.materialQueue?.ups ?? 4
  return Math.max(1, Math.floor(u))
}

function sheetDims(l: SuggestableLine) {
  const sl = num(l.materialQueue?.sheetLengthMm)
  const sw = num(l.materialQueue?.sheetWidthMm)
  const sheetLengthMm = sl > 0 ? sl : SUGGEST_DEFAULTS.defaultSheetL
  const sheetWidthMm = sw > 0 ? sw : SUGGEST_DEFAULTS.defaultSheetW
  return { sheetLengthMm, sheetWidthMm }
}

function blankDims(l: SuggestableLine) {
  const bl = num(l.carton?.blankLength ?? l.dimLengthMm)
  const bw = num(l.carton?.blankWidth ?? l.dimWidthMm)
  return { bl, bw }
}

export function estimatedSheetsForLine(l: SuggestableLine): number {
  const ups = effUps(l)
  const { bl, bw } = blankDims(l)
  if (bl > 0 && bw > 0) {
    const sh = sheetDims(l)
    const { yieldPct } = computeSheetUtilization({
      blankLengthMm: bl,
      blankWidthMm: bw,
      sheetLengthMm: sh.sheetLengthMm,
      sheetWidthMm: sh.sheetWidthMm,
      ups,
    })
    const wasteFactor = 1 + Math.max(0, 100 - yieldPct) / 100
    return Math.max(1, Math.ceil((l.quantity / ups) * wasteFactor * 0.85))
  }
  return Math.max(1, Math.ceil(l.quantity / ups))
}

export function yieldPctForLine(l: SuggestableLine): number {
  const { bl, bw } = blankDims(l)
  if (bl <= 0 || bw <= 0) return 50
  const ups = effUps(l)
  const sh = sheetDims(l)
  const { yieldPct } = computeSheetUtilization({
    blankLengthMm: bl,
    blankWidthMm: bw,
    sheetLengthMm: sh.sheetLengthMm,
    sheetWidthMm: sh.sheetWidthMm,
    ups,
  })
  return yieldPct
}

function blankArea(l: SuggestableLine): number {
  const { bl, bw } = blankDims(l)
  if (bl > 0 && bw > 0) return bl * bw
  return 0
}

function sortForBatching(a: SuggestableLine, b: SuggestableLine): number {
  const ar = blankArea(a)
  const br = blankArea(b)
  if (ar !== br) return ar - br
  return b.quantity - a.quantity
}

/**
 * Urgency 0–1 from PO date age (older open orders = higher) + PO priority nudge.
 */
function urgency01(l: SuggestableLine): number {
  const t = Date.parse(l.po.poDate)
  if (!Number.isFinite(t)) return 0.5
  const days = Math.max(0, (Date.now() - t) / 86_400_000)
  const ageU = Math.min(1, days / 21)
  return Math.min(1, 0.35 * ageU + 0.35 * (l.po.isPriority ? 1 : 0) + 0.3 * 0.5)
}

function tooling01(l: SuggestableLine): number {
  if (l.planningLedger?.toolingInterlock?.allReady) return 1
  return 0.45
}

export type SuggestedBatch = {
  id: string
  groupKey: string
  lineIds: string[]
  totalQty: number
  /** Sum of per-line sheet estimates (upper-bound style) */
  estimatedSheets: number
  /** Mean yield (%) of lines in the batch (simple average) */
  meanYieldPct: number
  /** 100 - meanYield as proxy */
  estWastagePct: number
  /** Weighted 0–100 */
  score: number
  label: 'High' | 'Medium' | 'Low'
  subscores: { sizeFit: number; waste: number; urgency: number; tooling: number }
  /** For UI */
  lineSummaries: { id: string; cartonLabel: string; poNumber: string; qty: number; yieldPct: number }[]
}

function scoreBatch(
  lines: SuggestableLine[],
  meanYield: number,
  estWastage: number,
): { score: number; label: SuggestedBatch['label']; subscores: SuggestedBatch['subscores'] } {
  const sizeFit = Math.min(100, meanYield) / 100
  const waste = 1 - Math.min(100, estWastage) / 100
  const urg = lines.reduce((s, l) => s + urgency01(l), 0) / lines.length
  const tool = lines.reduce((s, l) => s + tooling01(l), 0) / lines.length
  const score = Math.round(1000 * (0.4 * sizeFit + 0.3 * waste + 0.2 * urg + 0.1 * tool)) / 10
  const label: SuggestedBatch['label'] = score >= 72 ? 'High' : score >= 50 ? 'Medium' : 'Low'
  return {
    score,
    label,
    subscores: {
      sizeFit: Math.round(1000 * sizeFit) / 10,
      waste: Math.round(1000 * waste) / 10,
      urgency: Math.round(1000 * urg) / 10,
      tooling: Math.round(1000 * tool) / 10,
    },
  }
}

function buildSuggestionId(groupKey: string, lineIds: string[]): string {
  return `${groupKey}::${[...lineIds].sort().join('.')}`
}

/**
 * Produces 0+ suggested gang batches. Lines with `planningStatus === 'closed'`, on hold, or
 * empty quantity are ignored.
 */
export function suggestBatches(
  lines: SuggestableLine[],
  opts: Partial<typeof SUGGEST_DEFAULTS> = {},
): SuggestedBatch[] {
  const o = { ...SUGGEST_DEFAULTS, ...opts }
  const eligible = lines.filter(
    (l) =>
      l.planningStatus !== 'closed' &&
      l.directorHold !== true &&
      l.quantity > 0,
  )
  if (eligible.length < o.minBatchSize) return []
  const byGroup = new Map<string, SuggestableLine[]>()
  for (const l of eligible) {
    const k = groupingKey(l)
    if (!byGroup.has(k)) byGroup.set(k, [])
    byGroup.get(k)!.push(l)
  }
  const out: SuggestedBatch[] = []
  for (const [groupKey, list] of Array.from(byGroup.entries())) {
    if (list.length < o.minBatchSize) continue
    const sorted = [...list].sort(sortForBatching)
    let i = 0
    while (i < sorted.length) {
      const batch: SuggestableLine[] = [sorted[i]!]
      let sheetSum = estimatedSheetsForLine(sorted[i]!)
      const yields: number[] = [yieldPctForLine(sorted[i]!)]
      let j = i + 1
      while (j < sorted.length && batch.length < o.maxLinesPerBatch) {
        const next = sorted[j]!
        const tSheet = sheetSum + estimatedSheetsForLine(next)
        const tY = [...yields, yieldPctForLine(next)]
        const newAvg = tY.reduce((a, b) => a + b, 0) / tY.length
        if (tSheet > o.maxBatchSheetCount || newAvg < o.minAverageYieldToContinue) break
        batch.push(next)
        sheetSum = tSheet
        yields.length = 0
        yields.push(...tY)
        j++
      }
      if (batch.length >= o.minBatchSize) {
        const meanYield = yields.reduce((a, b) => a + b, 0) / yields.length
        const estWast = Math.min(100, Math.max(0, 100 - meanYield + 2))
        const { score, label, subscores } = scoreBatch(batch, meanYield, estWast)
        const lineIds = batch.map((b) => b.id)
        const id = buildSuggestionId(groupKey, lineIds)
        const lineSummaries = batch.map((b) => ({
          id: b.id,
          cartonLabel: b.cartonName,
          poNumber: b.po.poNumber,
          qty: b.quantity,
          yieldPct: Math.round(10 * yieldPctForLine(b)) / 10,
        }))
        out.push({
          id,
          groupKey,
          lineIds,
          totalQty: batch.reduce((s, b) => s + b.quantity, 0),
          estimatedSheets: sheetSum,
          meanYieldPct: Math.round(10 * meanYield) / 10,
          estWastagePct: Math.round(10 * estWast) / 10,
          score,
          label,
          subscores,
          lineSummaries,
        })
        i = j
      } else {
        i += 1
      }
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out
}
