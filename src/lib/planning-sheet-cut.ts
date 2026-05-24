/**
 * Planning Engine — structured sheet & cut math.
 *
 * The planner enters a child (cut) sheet size + cut count; the parent board
 * sheet size is auto-derived and locked. Canonical storage is always millimetres
 * (matching the inventory schema + cut-fit backend); inches is a display unit.
 *
 * Parent derivation uses strip cutting (inverse):
 *   parent.longer = child.longer × cutType
 *   parent.shorter = child.shorter
 *
 * The child derivation (`deriveChildSizeMm`) is preserved for backward compat
 * and for self-consistency checks: deriveChildSizeMm(derivedParent, cutType)
 * must equal the entered child size.
 */

export const IN_TO_MM = 25.4

export type SheetUnit = 'in' | 'mm'

export function isSheetUnit(v: unknown): v is SheetUnit {
  return v === 'in' || v === 'mm'
}

/** Convert a positive value in the given unit to millimetres. Non-positive → 0. */
export function toMm(value: number, unit: SheetUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return unit === 'in' ? value * IN_TO_MM : value
}

/** Convert millimetres to the given display unit. Non-positive → 0. */
export function fromMm(mm: number, unit: SheetUnit): number {
  if (!Number.isFinite(mm) || mm <= 0) return 0
  return unit === 'in' ? mm / IN_TO_MM : mm
}

/** Display rounding: whole mm, or 2-decimal inches. */
export function roundForUnit(value: number, unit: SheetUnit): number {
  if (!Number.isFinite(value)) return 0
  return unit === 'in' ? Math.round(value * 100) / 100 : Math.round(value)
}

/**
 * Locked child-size derivation. Splits the longer parent edge by the cut count.
 * Returns null when inputs are invalid (non-positive dims or cut < 1).
 */
export function deriveChildSizeMm(
  parentLengthMm: number,
  parentWidthMm: number,
  cutType: number,
): { lengthMm: number; widthMm: number } | null {
  const pl = Number(parentLengthMm)
  const pw = Number(parentWidthMm)
  const n = Math.floor(Number(cutType))
  if (!(pl > 0) || !(pw > 0) || !(n >= 1)) return null
  const long = Math.max(pl, pw)
  const short = Math.min(pl, pw)
  // Floor (not round) the split edge so floor(parentLong / childLong) === cutType
  // always holds — keeps the derivation consistent with the grid cut math.
  // The short edge is preserved at full precision (it doesn't affect cut count)
  // so an inch round-trip displays cleanly.
  return { lengthMm: Math.floor(long / n), widthMm: short }
}

/** Canonical mm size string (e.g. "720x1020") consumed by parseSheetSizeToPair / cut-fit. */
export function formatSizeMm(lengthMm: number, widthMm: number): string {
  if (!(lengthMm > 0) || !(widthMm > 0)) return ''
  return `${Math.round(lengthMm)}x${Math.round(widthMm)}`
}

/** Human display string in the chosen unit (e.g. "28.35 × 40.16 in" or "720 × 1020 mm"). */
export function formatSizeDisplay(lengthMm: number, widthMm: number, unit: SheetUnit): string {
  if (!(lengthMm > 0) || !(widthMm > 0)) return '—'
  const l = roundForUnit(fromMm(lengthMm, unit), unit)
  const w = roundForUnit(fromMm(widthMm, unit), unit)
  return `${l} × ${w} ${unit}`
}

/**
 * Locked parent-size derivation (inverse of deriveChildSizeMm).
 * Multiplies the longer child edge by the cut count to reconstruct the parent.
 *   parent.longer = child.longer × cutType
 *   parent.shorter = child.shorter
 * Returns null when inputs are invalid (non-positive dims or cut < 1).
 */
export function deriveParentSizeMm(
  childLengthMm: number,
  childWidthMm: number,
  cutType: number,
): { lengthMm: number; widthMm: number } | null {
  const cl = Number(childLengthMm)
  const cw = Number(childWidthMm)
  const n = Math.floor(Number(cutType))
  if (!(cl > 0) || !(cw > 0) || !(n >= 1)) return null
  const long = Math.max(cl, cw)
  const short = Math.min(cl, cw)
  return { lengthMm: long * n, widthMm: short }
}
