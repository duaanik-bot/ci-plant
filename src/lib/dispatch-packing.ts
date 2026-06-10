/**
 * Helpers for the Pasting → Dispatch → Billing → Short & Excess flow.
 *
 * Packing config: operators in Pasting record how the finished cartons are packed
 * into boxes — e.g. 4 boxes × 3000 cartons + 2 boxes × 1000 cartons = 14,000 total.
 * That shape is captured here once and travels through the rest of the flow.
 */

export type PackingRow = { boxes: number; qtyPerBox: number }
export type PackingConfig = PackingRow[]

export function normalizePackingConfig(input: unknown): PackingConfig {
  if (!Array.isArray(input)) return []
  const out: PackingRow[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const boxes = Math.floor(Number(r.boxes ?? 0))
    const qtyPerBox = Math.floor(Number(r.qtyPerBox ?? 0))
    if (!Number.isFinite(boxes) || boxes <= 0) continue
    if (!Number.isFinite(qtyPerBox) || qtyPerBox <= 0) continue
    out.push({ boxes, qtyPerBox })
  }
  return out
}

export function packingTotal(rows: PackingConfig): number {
  return rows.reduce((sum, r) => sum + r.boxes * r.qtyPerBox, 0)
}

export function packingSummaryText(rows: PackingConfig): string {
  if (rows.length === 0) return '—'
  return rows.map((r) => `${r.boxes}×${r.qtyPerBox.toLocaleString('en-IN')}`).join(' + ')
}

/**
 * Indian-style allowed-qty math. `poQty * (1 + tolerance/100)`, rounded down.
 * Tolerance defaults to PoLineItem.tolerancePct (default 2%).
 */
export function computeAllowedQty(poQty: number, tolerancePct: number): number {
  if (!Number.isFinite(poQty) || poQty <= 0) return 0
  const tol = Number.isFinite(tolerancePct) && tolerancePct > 0 ? tolerancePct : 0
  return Math.floor(poQty * (1 + tol / 100))
}

/**
 * Excess = qtyDispatched - allowedQty, clamped at 0.
 * When excess > 0 the dispatch row should write a ShortExcessRecord.
 */
export function computeExcessQty(qtyDispatched: number, allowedQty: number): number {
  return Math.max(0, Math.floor(qtyDispatched) - Math.floor(allowedQty))
}

export type ToleranceFlag = { flag: 'ok' | 'short' | 'excess'; varianceQty: number }

export function computeToleranceFlag(poQty: number, actualQty: number, tolerancePct: number): ToleranceFlag {
  const upperAllowedQty = computeAllowedQty(poQty, tolerancePct)
  const lowerAllowedQty = Math.ceil(poQty * (1 - tolerancePct / 100))
  if (actualQty > upperAllowedQty) {
    return { flag: 'excess', varianceQty: computeExcessQty(actualQty, upperAllowedQty) }
  }
  if (actualQty < lowerAllowedQty) {
    return { flag: 'short', varianceQty: actualQty - lowerAllowedQty }
  }
  return { flag: 'ok', varianceQty: 0 }
}

/**
 * Read the packingConfig saved by the pasting drawer into
 * `postPressRouting.executionOrchestration.stageProgress.pasting.packingConfig`.
 *
 * Returns an empty array when nothing was saved (legacy job cards).
 */
export function readPackingFromJobCard(postPressRouting: unknown): PackingConfig {
  if (!postPressRouting || typeof postPressRouting !== 'object') return []
  const pp = postPressRouting as Record<string, unknown>
  const exec = pp.executionOrchestration && typeof pp.executionOrchestration === 'object'
    ? (pp.executionOrchestration as Record<string, unknown>)
    : null
  if (!exec) return []
  const progress = exec.stageProgress && typeof exec.stageProgress === 'object'
    ? (exec.stageProgress as Record<string, unknown>)
    : null
  if (!progress) return []
  const pasting = progress.pasting && typeof progress.pasting === 'object'
    ? (progress.pasting as Record<string, unknown>)
    : null
  if (!pasting) return []
  return normalizePackingConfig(pasting.packingConfig)
}
