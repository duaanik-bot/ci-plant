/** Parse first two positive numbers from labels like "20x30 in", "508×762 mm", "20.5 x 30". */
export function parseSheetDims(label: string | null | undefined): { a: number; b: number } | null {
  if (label == null || !String(label).trim()) return null
  const raw = String(label)
  const nums = raw.match(/\d+(?:\.\d+)?/g)
  if (!nums || nums.length < 2) return null
  const a = Number(nums[0])
  const b = Number(nums[1])
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null
  const x = Math.min(a, b)
  const y = Math.max(a, b)
  return { a: x, b: y }
}

export type GrainFitStatus = 'unknown' | 'ok' | 'critical_mismatch' | 'pre_trim_required'

const EPS = 0.02

/**
 * Compare inventory sheet label vs AW queue target (actualSheetSize).
 * Critical when either inventory dimension is smaller than target (cannot fit).
 * Pre-trim when either dimension is larger than target.
 */
export function evaluateGrainFit(
  inventorySheetLabel: string | null | undefined,
  awTargetSheetSize: string | null | undefined,
): { status: GrainFitStatus } {
  const inv = parseSheetDims(inventorySheetLabel)
  const tgt = parseSheetDims(awTargetSheetSize)
  if (!inv || !tgt) return { status: 'unknown' }

  const invSmall = inv.a < tgt.a * (1 - EPS) || inv.b < tgt.b * (1 - EPS)
  if (invSmall) return { status: 'critical_mismatch' }

  const invLarge = inv.a > tgt.a * (1 + EPS) || inv.b > tgt.b * (1 + EPS)
  if (invLarge) return { status: 'pre_trim_required' }

  return { status: 'ok' }
}
