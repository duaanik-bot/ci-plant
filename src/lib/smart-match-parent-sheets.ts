/**
 * Smart Match — warehouse-driven parent-sheet matcher for the Planning engine.
 *
 * Given a required child sheet size, a cut type, board/GSM and a required
 * quantity, this ranks the parent sheets that actually exist in the Paper
 * Warehouse (db.inventory) and can produce that child under the selected cut
 * type. It answers: "which parent sheets in stock can I use for this child?"
 *
 * Cut-type model = EQUAL DIVISIONS (per planner decision): an N-cut slices the
 * parent into N equal rectangular sub-sheets first, then fits children into
 * each sub-sheet. A parent qualifies only if the child fits in a sub-sheet (in
 * either orientation). Pieces per parent = N × children-per-sub-sheet.
 *
 * Pure functions only — no I/O. The component feeds it the candidate pool the
 * readiness API already returns (board/GSM-matched warehouse stock).
 *
 * TODO (next phase — Balance / Leftover stock management, NOT in this commit):
 * `balanceSize` here is display-only (the leftover rectangle after a cut). The
 * full leftover lifecycle is out of scope for now and must NOT mutate stock:
 *   - register balance/leftover as reusable stock (new sub-sheet inventory rows)
 *   - match a child against existing leftover/balance stock before full parents
 *   - create a new stock master entry for a produced sub-size
 *   - scrap vs keep decision for sub-threshold offcuts
 *   - traceability link from parent → leftover → consuming job
 * Today this helper only ranks full parent sheets; it never writes inventory.
 */

export type CutType = 1 | 2 | 3 | 4 | 5 | 6
export type LengthUnit = 'inch' | 'mm'
export const CUT_TYPES: CutType[] = [1, 2, 3, 4, 5, 6]
export const PREFERRED_AUTO_CUT_TYPES: CutType[] = [2, 4, 5, 3]

export const MM_PER_INCH = 25.4
/**
 * Parent sheet dimensions carry no unit in the warehouse data, so we infer it
 * by magnitude: inch sheets are small (e.g. 23×36, 25×38 — tens), mm sheets are
 * large (e.g. 720×1020 — hundreds). Any dimension above this threshold is
 * treated as mm, otherwise inch. The planner's typed child dims are then
 * converted into the parent's inferred unit before fitting. Heuristic, but
 * unambiguous for real board sizes (no inch sheet exceeds ~60; no mm sheet is
 * under ~200). Revisit if a unit column is ever added to inventory.
 */
const MM_THRESHOLD = 200
const FIT_EPSILON = 0.01

export type ParentSheetMatchLabel =
  | 'Best Parent Sheet'
  | 'Lowest Waste'
  | 'Most Available'
  | 'Closest Fit'
  | 'Manual Review'

/** Candidate parent sheet sourced from warehouse stock (readiness board options). */
export type ParentSheetCandidate = {
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  /** Raw size string e.g. "23 x 36", "720×1020". Parsed when length/width absent. */
  size: string
  parentLength?: number | null
  parentWidth?: number | null
  freeSheets: number
  availableSheets: number
  gsmDelta?: number | null
}

export type ParentSheetMatchInput = {
  childLength: number
  childWidth: number
  cutType: CutType
  /** Required quantity of child sheets to produce. */
  requiredQty: number
  /** Unit the child dimensions are entered in. */
  unit: LengthUnit
  boardType?: string | null
  gsm?: number | null
  candidates: ParentSheetCandidate[]
  allowRotation?: boolean
}

export type ParentSheetMatch = {
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  cutType: CutType
  /** Inferred display unit for this candidate's sizes. */
  unit: LengthUnit
  parentLength: number
  parentWidth: number
  parentSize: string
  childSize: string
  subSheetSize: string
  childrenPerDivision: number
  piecesPerSheet: number
  requiredParentSheets: number
  availableStock: number
  freeStock: number
  shortageParentSheets: number
  balanceSize: string | null
  utilizationPct: number
  wastePct: number
  sufficientStock: boolean
  orientation: 'normal' | 'rotated'
  matchScore: number
  boardExact: boolean
  gsmExact: boolean
  label: ParentSheetMatchLabel
  reason: string
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Parse "23 x 36", "720×1020", "23*36", "23 X 36 in" → { length, width }. */
export function parseSheetDims(size: string | null | undefined): { length: number; width: number } | null {
  if (!size) return null
  const nums = String(size)
    .replace(/[×xX*]/g, ' ')
    .match(/\d+(?:\.\d+)?/g)
  if (!nums || nums.length < 2) return null
  const length = Number(nums[0])
  const width = Number(nums[1])
  if (!Number.isFinite(length) || !Number.isFinite(width) || length <= 0 || width <= 0) return null
  return { length, width }
}

/** Integer factor pairs (a along length, b along width) with a*b === n. */
export function factorPairs(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let a = 1; a <= n; a++) {
    if (n % a === 0) out.push([a, n / a])
  }
  return out
}

function inferUnit(maxDim: number): LengthUnit {
  return maxDim > MM_THRESHOLD ? 'mm' : 'inch'
}

function formatSize(length: number, width: number, unit: LengthUnit): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))
  return `${fmt(length)} × ${fmt(width)} ${unit === 'mm' ? 'mm' : 'in'}`
}

type SubFit = { count: number; orientation: 'normal' | 'rotated' }

/** Max children that fit in a single sub-sheet via floor division (both orientations). */
function fitChildrenInSub(
  subL: number,
  subW: number,
  childL: number,
  childW: number,
  allowRotation: boolean,
): SubFit {
  const e = FIT_EPSILON
  const normal = Math.floor((subL + e) / childL) * Math.floor((subW + e) / childW)
  const rotated = allowRotation ? Math.floor((subL + e) / childW) * Math.floor((subW + e) / childL) : 0
  if (rotated > normal) return { count: Math.max(0, rotated), orientation: 'rotated' }
  return { count: Math.max(0, normal), orientation: 'normal' }
}

export type EqualDivisionFit = {
  qualifies: boolean
  childrenPerDivision: number
  piecesPerSheet: number
  subLength: number
  subWidth: number
  orientation: 'normal' | 'rotated'
  utilizationPct: number
  wastePct: number
  balanceLength: number | null
  balanceWidth: number | null
}

/**
 * Slice the parent into `cutType` equal sub-sheets and fit the child into each.
 * Picks the division layout that yields the most children (best utilization).
 */
export function computeEqualDivisionFit(input: {
  parentLength: number
  parentWidth: number
  childLength: number
  childWidth: number
  cutType: CutType
  allowRotation?: boolean
}): EqualDivisionFit {
  const parentL = num(input.parentLength)
  const parentW = num(input.parentWidth)
  const childL = num(input.childLength)
  const childW = num(input.childWidth)
  const cutType = input.cutType
  const allowRotation = input.allowRotation !== false
  const empty: EqualDivisionFit = {
    qualifies: false,
    childrenPerDivision: 0,
    piecesPerSheet: 0,
    subLength: 0,
    subWidth: 0,
    orientation: 'normal',
    utilizationPct: 0,
    wastePct: 100,
    balanceLength: null,
    balanceWidth: null,
  }
  if (parentL <= 0 || parentW <= 0 || childL <= 0 || childW <= 0 || cutType < 1) return empty

  const parentArea = parentL * parentW
  const childArea = childL * childW

  let best: EqualDivisionFit | null = null
  for (const [a, b] of factorPairs(cutType)) {
    const subL = parentL / a
    const subW = parentW / b
    const fit = fitChildrenInSub(subL, subW, childL, childW, allowRotation)
    if (fit.count <= 0) continue

    const piecesPerSheet = fit.count * cutType
    const usedArea = piecesPerSheet * childArea
    const utilizationPct = parentArea > 0 ? Math.min(100, (usedArea / parentArea) * 100) : 0

    // Leftover within one sub-sheet after laying out fit.count children.
    const childOriented = fit.orientation === 'rotated' ? { l: childW, w: childL } : { l: childL, w: childW }
    const nx = Math.floor((subL + FIT_EPSILON) / childOriented.l)
    const ny = Math.floor((subW + FIT_EPSILON) / childOriented.w)
    const usedL = childOriented.l * nx
    const usedW = childOriented.w * ny
    const rightArea = Math.max(0, subL - usedL) * subW
    const bottomArea = usedL * Math.max(0, subW - usedW)
    let balanceLength: number | null = null
    let balanceWidth: number | null = null
    if (rightArea >= bottomArea && rightArea > FIT_EPSILON) {
      balanceLength = round1(subL - usedL)
      balanceWidth = round1(subW)
    } else if (bottomArea > FIT_EPSILON) {
      balanceLength = round1(usedL)
      balanceWidth = round1(subW - usedW)
    }

    const candidate: EqualDivisionFit = {
      qualifies: true,
      childrenPerDivision: fit.count,
      piecesPerSheet,
      subLength: round1(subL),
      subWidth: round1(subW),
      orientation: fit.orientation,
      utilizationPct: round1(utilizationPct),
      wastePct: round1(Math.max(0, 100 - utilizationPct)),
      balanceLength,
      balanceWidth,
    }
    if (!best || candidate.piecesPerSheet > best.piecesPerSheet) best = candidate
  }

  return best ?? empty
}

export type ComputeParentResult = {
  /** Squarest geometric tiling of the child (sorted ascending), in the child's unit. */
  rawLength: number
  rawWidth: number
  /** After snapping to an inventory master size (== raw when no master fits). */
  length: number
  width: number
  snappedTo: 'master' | null
  /**
   * Chosen [a, b] factor pair from the squarest tiling, where `a` tiles the
   * child's ORIGINAL length axis and `b` its width axis (a*b === cutType).
   * Note: this is pre-sort — it relates to childLength/childWidth, NOT to the
   * sorted rawLength/rawWidth fields above.
   */
  grid: [number, number]
}

/**
 * Compute the parent sheet needed to yield `cutType` children of the given size.
 * Tiles the child into the squarest a×b grid, then snaps up to the smallest
 * inventory-master size (`snapTargets`) that is ≥ the tiled parent in both dims.
 * Pure — no I/O. Returns null for invalid child dims.
 */
export function computeParentFromChild(input: {
  childLength: number
  childWidth: number
  cutType: CutType
  unit: LengthUnit
  snapTargets?: string[]
}): ComputeParentResult | null {
  const cl = num(input.childLength)
  const cw = num(input.childWidth)
  if (cl <= 0 || cw <= 0 || input.cutType < 1) return null

  // 1. Squarest tiling: minimise aspect ratio, tie-break on larger min-dimension.
  let grid: [number, number] = [1, 1]
  let tiledL = cl
  let tiledW = cw
  let bestRatio = Infinity
  let bestMinDim = -Infinity
  for (const [a, b] of factorPairs(input.cutType)) {
    const L = cl * a
    const W = cw * b
    const ratio = Math.max(L, W) / Math.min(L, W)
    const minDim = Math.min(L, W)
    if (ratio < bestRatio - 1e-9 || (Math.abs(ratio - bestRatio) <= 1e-9 && minDim > bestMinDim)) {
      bestRatio = ratio
      bestMinDim = minDim
      grid = [a, b]
      tiledL = L
      tiledW = W
    }
  }
  const rawLow = Math.min(tiledL, tiledW)
  const rawHigh = Math.max(tiledL, tiledW)

  // 2. Snap up to the smallest master size ≥ the tiled parent (orientation-aware).
  let length = round1(rawLow)
  let width = round1(rawHigh)
  let snappedTo: 'master' | null = null
  let bestArea = Infinity
  for (const label of input.snapTargets ?? []) {
    const dims = parseSheetDims(label)
    if (!dims) continue
    // Normalise the target into the child's unit by magnitude inference.
    const tUnit = inferUnit(Math.max(dims.length, dims.width))
    const conv = (n: number) =>
      tUnit === input.unit ? n : input.unit === 'inch' ? n / MM_PER_INCH : n * MM_PER_INCH
    const lo = Math.min(conv(dims.length), conv(dims.width))
    const hi = Math.max(conv(dims.length), conv(dims.width))
    if (lo + FIT_EPSILON >= rawLow && hi + FIT_EPSILON >= rawHigh) {
      const area = lo * hi
      if (area < bestArea - FIT_EPSILON) {
        bestArea = area
        length = round1(lo)
        width = round1(hi)
        snappedTo = 'master'
      }
    }
  }

  return { rawLength: round1(rawLow), rawWidth: round1(rawHigh), length, width, snappedTo, grid }
}

function canonBoard(s: string | null | undefined): string {
  return String(s ?? '').trim().toLowerCase()
}

function boardMatches(selected: string | null | undefined, candidate: string | null | undefined): boolean {
  const a = canonBoard(selected)
  const b = canonBoard(candidate)
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}

/**
 * Rank warehouse parent sheets that can produce the child under the cut type.
 * Returns only valid (qualifying) options, ranked, with business labels.
 */
export function rankParentSheetMatches(input: ParentSheetMatchInput): ParentSheetMatch[] {
  const cutType = input.cutType
  const requiredQty = Math.max(1, Math.ceil(num(input.requiredQty)))
  const allowRotation = input.allowRotation !== false
  const selectedBoard = input.boardType ?? null
  const selectedGsm = input.gsm == null ? null : num(input.gsm)

  const matches: ParentSheetMatch[] = []
  const seen = new Set<string>()

  for (const c of input.candidates) {
    if (!c.materialId || seen.has(c.materialId)) continue
    const dims =
      c.parentLength != null && c.parentWidth != null && num(c.parentLength) > 0 && num(c.parentWidth) > 0
        ? { length: num(c.parentLength), width: num(c.parentWidth) }
        : parseSheetDims(c.size)
    if (!dims) continue
    seen.add(c.materialId)

    const unit = inferUnit(Math.max(dims.length, dims.width))
    // Child entered in `input.unit`; convert to the parent's inferred unit.
    const childRaw = { l: num(input.childLength), w: num(input.childWidth) }
    const childMm = input.unit === 'mm' ? childRaw : { l: childRaw.l * MM_PER_INCH, w: childRaw.w * MM_PER_INCH }
    const child =
      unit === 'mm'
        ? childMm
        : { l: childMm.l / MM_PER_INCH, w: childMm.w / MM_PER_INCH }
    if (child.l <= 0 || child.w <= 0) continue

    const fit = computeEqualDivisionFit({
      parentLength: dims.length,
      parentWidth: dims.width,
      childLength: child.l,
      childWidth: child.w,
      cutType,
      allowRotation,
    })
    if (!fit.qualifies || fit.piecesPerSheet <= 0) continue

    const freeStock = num(c.freeSheets)
    const availableStock = num(c.availableSheets)
    const requiredParentSheets = Math.max(1, Math.ceil(requiredQty / fit.piecesPerSheet))
    const usableFree = Math.max(0, freeStock)
    const shortageParentSheets = Math.max(0, requiredParentSheets - usableFree)
    const sufficientStock = usableFree >= requiredParentSheets

    const boardExact = boardMatches(selectedBoard, c.boardType)
    const gsmDelta = c.gsmDelta != null ? Math.abs(num(c.gsmDelta)) : selectedGsm != null && c.gsm != null ? Math.abs(num(c.gsm) - selectedGsm) : null
    const gsmExact = gsmDelta != null && gsmDelta === 0

    const balanceSize =
      fit.balanceLength != null && fit.balanceWidth != null && fit.balanceLength > 0 && fit.balanceWidth > 0
        ? formatSize(fit.balanceLength, fit.balanceWidth, unit)
        : null

    // Match score (0–100) ordered by the spec's ranking priority.
    const boardPts = selectedBoard ? (boardExact ? 22 : 0) : 18
    const gsmPts = gsmExact ? 14 : gsmDelta != null && gsmDelta <= 10 ? Math.max(0, 14 - gsmDelta) : 0
    const utilPts = 40 * (fit.utilizationPct / 100)
    const stockPts = sufficientStock ? 16 : usableFree > 0 ? 16 * (usableFree / requiredParentSheets) : 0
    const balancePenalty =
      fit.balanceLength != null && fit.balanceWidth != null
        ? 8 * ((fit.balanceLength * fit.balanceWidth) / (dims.length * dims.width))
        : 0
    const matchScore = Math.max(0, Math.min(100, round1(boardPts + gsmPts + utilPts + stockPts + 8 - balancePenalty)))

    matches.push({
      materialId: c.materialId,
      materialCode: c.materialCode,
      boardType: c.boardType,
      gsm: c.gsm,
      cutType,
      unit,
      parentLength: dims.length,
      parentWidth: dims.width,
      parentSize: formatSize(dims.length, dims.width, unit),
      childSize: formatSize(round1(child.l), round1(child.w), unit),
      subSheetSize: formatSize(fit.subLength, fit.subWidth, unit),
      childrenPerDivision: fit.childrenPerDivision,
      piecesPerSheet: fit.piecesPerSheet,
      requiredParentSheets,
      availableStock,
      freeStock,
      shortageParentSheets,
      balanceSize,
      utilizationPct: fit.utilizationPct,
      wastePct: fit.wastePct,
      sufficientStock,
      orientation: fit.orientation,
      matchScore,
      boardExact,
      gsmExact,
      label: 'Closest Fit',
      reason: '',
    })
  }

  matches.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore
    if (a.boardExact !== b.boardExact) return a.boardExact ? -1 : 1
    if (a.gsmExact !== b.gsmExact) return a.gsmExact ? -1 : 1
    if (b.utilizationPct !== a.utilizationPct) return b.utilizationPct - a.utilizationPct
    if (a.sufficientStock !== b.sufficientStock) return a.sufficientStock ? -1 : 1
    if (b.freeStock !== a.freeStock) return b.freeStock - a.freeStock
    return a.materialCode.localeCompare(b.materialCode)
  })

  assignLabels(matches)
  for (const m of matches) m.reason = buildReason(m, selectedBoard)
  return matches
}

export function pickPreferredParentSheetMatch(
  input: Omit<ParentSheetMatchInput, 'cutType'> & { cutPreference?: CutType[] },
): ParentSheetMatch | null {
  const cutPreference = input.cutPreference?.length ? input.cutPreference : PREFERRED_AUTO_CUT_TYPES
  for (const cutType of cutPreference) {
    const matches = rankParentSheetMatches({ ...input, cutType })
    if (matches.length > 0) return matches[0]!
  }
  return null
}

function assignLabels(matches: ParentSheetMatch[]): void {
  if (matches.length === 0) return
  const sufficient = matches.filter((m) => m.sufficientStock)
  const lowestWaste = sufficient.reduce<ParentSheetMatch | null>(
    (best, m) => (best == null || m.wastePct < best.wastePct ? m : best),
    null,
  )
  const mostAvailable = sufficient.reduce<ParentSheetMatch | null>(
    (best, m) => (best == null || m.freeStock > best.freeStock ? m : best),
    null,
  )
  const bestId = sufficient[0]?.materialId ?? null
  for (const m of matches) {
    if (!m.sufficientStock) {
      m.label = 'Manual Review'
    } else if (m.materialId === bestId) {
      m.label = 'Best Parent Sheet'
    } else if (lowestWaste && m.materialId === lowestWaste.materialId) {
      m.label = 'Lowest Waste'
    } else if (mostAvailable && m.materialId === mostAvailable.materialId) {
      m.label = 'Most Available'
    } else {
      m.label = 'Closest Fit'
    }
  }
}

const nfIN = new Intl.NumberFormat('en-IN')

function buildReason(m: ParentSheetMatch, selectedBoard: string | null): string {
  const parts: string[] = []
  if (m.boardExact && m.gsmExact) parts.push('Exact board & GSM')
  else if (m.boardExact) parts.push('Exact board')
  else if (selectedBoard) parts.push('Compatible board')
  parts.push(`${m.cutType}-cut → ${nfIN.format(m.piecesPerSheet)}/sheet`)
  parts.push(`${m.utilizationPct}% used`)
  if (m.sufficientStock) parts.push(`${nfIN.format(Math.max(0, Math.round(m.freeStock)))} free sh — no PR needed`)
  else parts.push(`short ${nfIN.format(Math.round(m.shortageParentSheets))} sh — raise PR`)
  return parts.join(' · ')
}
