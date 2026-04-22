/**
 * Batch Decision Engine — workflow only. Does not change UPS, grouping, or sheet estimates.
 */

import {
  readPlanningCore,
  type PlanningBatchStatus,
  type PlanningCore,
} from './planning-decision-spec'

export type PlanningBatchDecisionAction =
  | 'approve_batch'
  | 'hold_batch'
  | 'send_to_artwork'
  | 'release_to_production'
  | 'resume_from_hold'

export const BATCH_STATUS_LABEL: Record<PlanningBatchStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  hold: 'Hold',
  approved_for_artwork: 'Approved for Artwork',
  released_to_production: 'Released to Production',
}

/** Tailwind classes for compact badges (dark planning theme). */
export const BATCH_STATUS_BADGE_CLASS: Record<PlanningBatchStatus, string> = {
  draft: 'bg-slate-600/90 text-white border-slate-500',
  ready: 'bg-sky-700/95 text-white border-sky-500',
  hold: 'bg-rose-900/90 text-rose-100 border-rose-600',
  approved_for_artwork: 'bg-violet-800/95 text-violet-50 border-violet-500',
  released_to_production: 'bg-emerald-800/95 text-emerald-50 border-emerald-600',
}

export function effectiveBatchStatus(core: PlanningCore): PlanningBatchStatus {
  const s = core.batchStatus
  if (
    s === 'draft' ||
    s === 'ready' ||
    s === 'hold' ||
    s === 'approved_for_artwork' ||
    s === 'released_to_production'
  ) {
    return s
  }
  return 'draft'
}

/** Batches on hold are excluded from forward workflow (AW / production handoff from this UI). */
export function isBatchExcludedFromForwardSteps(core: PlanningCore): boolean {
  return effectiveBatchStatus(core) === 'hold'
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Returns updated planningCore fields for a batch action, or null if invalid.
 */
export function applyBatchDecisionAction(
  prev: PlanningCore,
  action: PlanningBatchDecisionAction,
  options?: { holdReason?: string },
): PlanningCore | null {
  const s = effectiveBatchStatus(prev)
  const touch = { ...prev, batchDecisionUpdatedAt: nowIso() }

  switch (action) {
    case 'approve_batch': {
      if (s !== 'draft') return null
      return {
        ...touch,
        batchStatus: 'ready',
        batchHoldReason: null,
        batchStatusBeforeHold: null,
      }
    }
    case 'hold_batch': {
      if (s === 'hold' || s === 'released_to_production') return null
      return {
        ...touch,
        batchStatus: 'hold',
        batchStatusBeforeHold: s,
        batchHoldReason: (options?.holdReason ?? '').trim() || '—',
      }
    }
    case 'send_to_artwork': {
      if (s !== 'ready') return null
      return {
        ...touch,
        batchStatus: 'approved_for_artwork',
        batchHoldReason: null,
        batchStatusBeforeHold: null,
      }
    }
    case 'release_to_production': {
      if (s !== 'approved_for_artwork') return null
      return {
        ...touch,
        batchStatus: 'released_to_production',
        batchHoldReason: null,
        batchStatusBeforeHold: null,
      }
    }
    case 'resume_from_hold': {
      if (s !== 'hold') return null
      const back = prev.batchStatusBeforeHold
      const next: PlanningBatchStatus =
        back === 'ready' ||
        back === 'draft' ||
        back === 'approved_for_artwork' ||
        back === 'released_to_production'
          ? back
          : 'draft'
      return {
        ...touch,
        batchStatus: next,
        batchHoldReason: null,
        batchStatusBeforeHold: null,
      }
    }
    default:
      return null
  }
}

export function projectPlanningBatchFields(src: PlanningCore): Partial<PlanningCore> {
  return {
    batchStatus: src.batchStatus,
    batchHoldReason: src.batchHoldReason,
    batchStatusBeforeHold: src.batchStatusBeforeHold,
    batchDecisionUpdatedAt: src.batchDecisionUpdatedAt,
  }
}

export function batchKeyForLine(lineId: string, core: PlanningCore): string {
  if (core.masterSetId && String(core.masterSetId).trim()) {
    return `gang:${core.masterSetId.trim()}`
  }
  return `line:${lineId}`
}

export type PlanningBatchGroup = {
  key: string
  lineIds: string[]
  /** Human label: master set id or "Single line" */
  title: string
}

export function buildBatchGroups(
  lines: { id: string; poNumber?: string; specOverrides: Record<string, unknown> | null }[],
): PlanningBatchGroup[] {
  const map = new Map<string, { lineIds: string[]; title: string }>()
  for (const r of lines) {
    const spec = (r.specOverrides && typeof r.specOverrides === 'object' ? r.specOverrides : {}) as Record<
      string,
      unknown
    >
    const core = readPlanningCore(spec)
    const k = batchKeyForLine(r.id, core)
    const title =
      core.layoutType === 'gang' && core.masterSetId
        ? core.masterSetId
        : `Single · ${(r.poNumber ?? '').trim() || r.id.slice(0, 8)}`
    if (!map.has(k)) {
      map.set(k, { lineIds: [], title })
    }
    const g = map.get(k)!
    g.lineIds.push(r.id)
  }
  return Array.from(map.entries()).map(([key, v]) => ({
    key,
    lineIds: v.lineIds,
    title: v.title,
  }))
}
