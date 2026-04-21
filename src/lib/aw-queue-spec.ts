/** AW Queue command-center fields stored in `po_line_items.specOverrides`. */

export const AW_PO_STATUS = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  REOPENED: 'REOPENED',
} as const

export type AwPoStatus = (typeof AW_PO_STATUS)[keyof typeof AW_PO_STATUS]

export const AW_PUSH_MODE = {
  ONE_GO: 'one_go',
  PARTIAL: 'partial',
} as const

export type AwPushMode = (typeof AW_PUSH_MODE)[keyof typeof AW_PUSH_MODE]

export type AwPartialPushLedgerEntry = {
  at: string
  batchCount: number
  jobCardId?: string | null
  jobCardNumber?: number | null
  operatorName?: string | null
}

export type AwClosureSnapshot = Record<string, unknown>

export function readAwPoStatus(spec: Record<string, unknown> | null | undefined): AwPoStatus {
  const v = spec?.awPoStatus
  if (v === AW_PO_STATUS.CLOSED || v === AW_PO_STATUS.REOPENED) return v
  return AW_PO_STATUS.OPEN
}

export function readPushMode(spec: Record<string, unknown> | null | undefined): AwPushMode {
  const v = spec?.awPushMode
  if (v === AW_PUSH_MODE.PARTIAL) return AW_PUSH_MODE.PARTIAL
  return AW_PUSH_MODE.ONE_GO
}

export function readPartialLedger(
  spec: Record<string, unknown> | null | undefined,
): AwPartialPushLedgerEntry[] {
  const raw = spec?.awPartialPushLedger
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (x): x is AwPartialPushLedgerEntry =>
      x != null &&
      typeof x === 'object' &&
      typeof (x as AwPartialPushLedgerEntry).at === 'string' &&
      typeof (x as AwPartialPushLedgerEntry).batchCount === 'number',
  )
}

export function totalContractBatches(spec: Record<string, unknown> | null | undefined): number {
  const v = spec?.totalContractBatches
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v)
  return 0
}

export function currentRunBatches(spec: Record<string, unknown> | null | undefined): number {
  const v = spec?.currentRunBatches
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v)
  return 0
}

export function remainingBatchBalance(spec: Record<string, unknown> | null | undefined): number {
  const t = totalContractBatches(spec)
  const c = currentRunBatches(spec)
  return Math.max(0, t - c)
}

export function awInProductionBatches(spec: Record<string, unknown> | null | undefined): number {
  const v = spec?.awInProductionBatches
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v)
  return 0
}

/** Shipped (emerald) / in-production (amber) / remaining (slate) — partitions total contract batches. */
export function batchProgressSegments(spec: Record<string, unknown> | null | undefined): {
  shippedPct: number
  inProductionPct: number
  remainingPct: number
} {
  const t = totalContractBatches(spec)
  if (t <= 0) {
    return { shippedPct: 0, inProductionPct: 0, remainingPct: 1 }
  }
  const shipped = Math.min(currentRunBatches(spec), t)
  const ip = Math.min(awInProductionBatches(spec), Math.max(0, t - shipped))
  const rem = Math.max(0, t - shipped - ip)
  return {
    shippedPct: shipped / t,
    inProductionPct: ip / t,
    remainingPct: rem / t,
  }
}
