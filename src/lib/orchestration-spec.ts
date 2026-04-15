/** Stored under `po_line_items.specOverrides.orchestration` for parallel plate vs planning flow. */

export type LineOrchestration = {
  plateFlowStatus?: string
  planningFlowStatus?: string
  planningForwardedAt?: string
}

export const PLATE_FLOW = {
  idle: 'idle',
  triage: 'triage',
  ctp_queue: 'ctp_queue',
  burning_complete: 'burning_complete',
  ready_inventory: 'ready_inventory',
} as const

export const PLANNING_FLOW = {
  idle: 'idle',
  forwarded: 'forwarded',
  in_progress: 'in_progress',
} as const

export function readOrchestration(spec: Record<string, unknown> | null | undefined): LineOrchestration {
  if (!spec || typeof spec !== 'object') return {}
  const o = spec.orchestration
  if (!o || typeof o !== 'object') return {}
  return o as LineOrchestration
}

export function mergeOrchestrationIntoSpec(
  spec: Record<string, unknown> | null | undefined,
  patch: Partial<LineOrchestration>,
): Record<string, unknown> {
  const base = spec && typeof spec === 'object' ? { ...spec } : {}
  const prev = readOrchestration(base)
  base.orchestration = { ...prev, ...patch }
  return base
}
