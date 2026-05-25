export type CutAllowances = {
  /** Gripper margin removed from ONE parent edge (the length/feed edge). */
  gripper: number
  /** Trim removed from every edge (subtracted twice per dimension). */
  edgeTrim: number
  /** Gap left between adjacent ups. */
  gutter: number
}

export const DEFAULT_ALLOWANCES: CutAllowances = { gripper: 0.5, edgeTrim: 0, gutter: 0 }

export type CutGeometry = {
  cutsPerSheet: number
  orientation: 'LxW' | 'WxL'
  yieldPct: number
  wastePct: number
  balanceLength: number
  balanceWidth: number
  balanceArea: number
  balanceSize: string | null
  balanceReusable: boolean
}

const EMPTY: CutGeometry = {
  cutsPerSheet: 0, orientation: 'LxW', yieldPct: 0, wastePct: 0,
  balanceLength: 0, balanceWidth: 0, balanceArea: 0, balanceSize: null, balanceReusable: false,
}

function pos(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : 0
}

function round2(x: number): number {
  return Number(x.toFixed(2))
}

function fmtDim(x: number): string {
  return String(round2(x))
}

/** How many `piece`-wide cuts fit along `usable`, leaving `gutter` between them. */
function fitCount(usable: number, piece: number, gutter: number): number {
  if (piece <= 0 || usable < piece) return 0
  return Math.floor((usable + gutter) / (piece + gutter))
}

export function computeCutGeometry(input: {
  parentLength: number
  parentWidth: number
  reqLength: number
  reqWidth: number
  allowances?: Partial<CutAllowances>
  /** Min side length for a balance offcut to count as reusable. Default = smaller child dim. */
  reusableMinDim?: number
}): CutGeometry {
  const parentL = pos(input.parentLength)
  const parentW = pos(input.parentWidth)
  const reqL = pos(input.reqLength)
  const reqW = pos(input.reqWidth)
  if (!parentL || !parentW || !reqL || !reqW) return EMPTY

  const a: CutAllowances = { ...DEFAULT_ALLOWANCES, ...(input.allowances || {}) }
  const reusableMinDim = input.reusableMinDim ?? Math.min(reqL, reqW)

  const usableL = parentL - a.gripper - 2 * a.edgeTrim
  const usableW = parentW - 2 * a.edgeTrim
  if (usableL <= 0 || usableW <= 0) return EMPTY

  // Orientation A: reqL along usableL, reqW along usableW. B: rotated.
  const colsA = fitCount(usableL, reqL, a.gutter)
  const rowsA = fitCount(usableW, reqW, a.gutter)
  const cutsA = colsA * rowsA
  const colsB = fitCount(usableL, reqW, a.gutter)
  const rowsB = fitCount(usableW, reqL, a.gutter)
  const cutsB = colsB * rowsB

  const useA = cutsA >= cutsB
  const cutsPerSheet = Math.max(cutsA, cutsB)
  if (cutsPerSheet <= 0) return EMPTY

  const pieceL = useA ? reqL : reqW
  const pieceW = useA ? reqW : reqL
  const cols = useA ? colsA : colsB
  const rows = useA ? rowsA : rowsB

  const usedL = cols * pieceL + (cols - 1) * a.gutter
  const usedW = rows * pieceW + (rows - 1) * a.gutter
  const remL = Math.max(0, usableL - usedL)
  const remW = Math.max(0, usableW - usedW)

  // Guillotine: keep the single larger leftover rectangle.
  const rightArea = remL * usableW
  const bottomArea = usableL * remW
  let bL = 0
  let bW = 0
  if (rightArea >= bottomArea && rightArea > 0) {
    bL = Math.max(remL, usableW)
    bW = Math.min(remL, usableW)
  } else if (bottomArea > 0) {
    bL = Math.max(usableL, remW)
    bW = Math.min(usableL, remW)
  }
  const balanceArea = bL * bW
  const balanceReusable = bL > 0 && bW > 0 && Math.min(bL, bW) >= reusableMinDim

  const parentArea = parentL * parentW
  const productArea = reqL * reqW * cutsPerSheet
  const recoverable = balanceReusable ? balanceArea : 0

  return {
    cutsPerSheet,
    orientation: useA ? 'LxW' : 'WxL',
    yieldPct: round2((productArea / parentArea) * 100),
    wastePct: round2(Math.max(0, ((parentArea - productArea - recoverable) / parentArea) * 100)),
    balanceLength: round2(bL),
    balanceWidth: round2(bW),
    balanceArea: round2(balanceArea),
    balanceSize: balanceArea > 0 ? `${fmtDim(bL)} x ${fmtDim(bW)}` : null,
    balanceReusable,
  }
}
