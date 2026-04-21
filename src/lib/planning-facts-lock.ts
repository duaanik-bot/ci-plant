/**
 * Server-side guard: after Planning saves `planningCore.savedAt`, UPS / set / gang / designer
 * handoff fields are authoritative unless a privileged user sends `planningDecisionRevision`
 * or the line is unlocked via recall-planning.
 */

import { readPlanningCore, type PlanningCore } from '@/lib/planning-decision-spec'

export function isPlanningFactsLocked(spec: Record<string, unknown> | null | undefined): boolean {
  const c = readPlanningCore(spec)
  return !!c.savedAt?.trim()
}

function planningCoreSnapshot(c: PlanningCore): string {
  const mix = c.mixSetMemberIds?.length ? [...c.mixSetMemberIds].sort() : null
  const o = {
    savedAt: c.savedAt ?? null,
    designerKey: c.designerKey ?? null,
    ups: c.ups ?? null,
    actualSheetSizeLabel: c.actualSheetSizeLabel ?? null,
    productionYieldPct: c.productionYieldPct ?? null,
    masterSetId: c.masterSetId ?? null,
    mixSetMemberIds: mix,
    setIdMode: c.setIdMode ?? null,
    resolvedSetNumber: c.resolvedSetNumber ?? null,
    layoutType: c.layoutType ?? null,
  }
  return JSON.stringify(o)
}

function normSet(s: string | null | undefined): string {
  return String(s ?? '').trim()
}

/** Roles / permission shape that may revise Planning decisions after handoff. */
export function userCanRevisePlanningDecision(user: {
  role?: string | null
  permissions?: unknown
}): boolean {
  const r = (user.role ?? '').trim().toLowerCase()
  if (['md', 'operations_head', 'production_manager'].includes(r)) return true
  const p = user.permissions
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const rec = p as Record<string, unknown>
    if (rec.production === 'full' || rec.jobs === 'full') return true
  }
  return false
}

export type PlanningFactsViolation = {
  ok: false
  message: string
  field?: string
}

/**
 * Returns violation if locked facts would change between existing and merged spec / set number.
 * Compares normalized planningCore, planningDesignerDisplayName, column setNumber, and root-level `ups`
 * when planningCore defines UPS.
 */
export function assertPlanningFactsUnchanged(args: {
  existingSpec: Record<string, unknown> | null | undefined
  mergedSpec: Record<string, unknown> | null | undefined
  existingSetNumber: string | null | undefined
  mergedSetNumber: string | null | undefined
  /** Keys explicitly sent on this PATCH (to detect attempted ups override). */
  touchedSpecKeys?: Set<string>
}): { ok: true } | PlanningFactsViolation {
  const ex = args.existingSpec && typeof args.existingSpec === 'object' ? args.existingSpec : {}
  const merged = args.mergedSpec && typeof args.mergedSpec === 'object' ? args.mergedSpec : {}

  if (!isPlanningFactsLocked(ex)) return { ok: true }

  const snapE = planningCoreSnapshot(readPlanningCore(ex))
  const snapM = planningCoreSnapshot(readPlanningCore(merged))
  if (snapE !== snapM) {
    return {
      ok: false,
      message:
        'Planning decision is locked. Use Planning → Recall, or request a Planning revision (authorised role).',
      field: 'specOverrides.planningCore',
    }
  }

  const pdE = String(ex.planningDesignerDisplayName ?? '').trim()
  const pdM = String(merged.planningDesignerDisplayName ?? '').trim()
  if (pdE !== pdM) {
    return {
      ok: false,
      message: 'Planning designer allocation is locked for this line.',
      field: 'specOverrides.planningDesignerDisplayName',
    }
  }

  if (normSet(args.existingSetNumber) !== normSet(args.mergedSetNumber)) {
    return {
      ok: false,
      message: 'Set number is locked by the Planning decision.',
      field: 'setNumber',
    }
  }

  const pcUps = readPlanningCore(ex).ups
  if (pcUps != null && args.touchedSpecKeys?.has('ups')) {
    const raw = merged.ups
    const n = typeof raw === 'number' ? raw : raw === null || raw === undefined ? null : Number(raw)
    if (n === null || Number.isNaN(n) || n !== pcUps) {
      return {
        ok: false,
        message: 'UPS is locked by the Planning decision.',
        field: 'specOverrides.ups',
      }
    }
  }

  return { ok: true }
}

/** PO line editor: keep planning handoff fields from the previous row when facts are locked. */
export function mergeSpecRespectingPlanningLock(
  existingSpec: Record<string, unknown> | null | undefined,
  incomingSpec: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const ex = existingSpec && typeof existingSpec === 'object' ? { ...existingSpec } : {}
  const inc = incomingSpec && typeof incomingSpec === 'object' ? { ...incomingSpec } : {}
  const merged = { ...ex, ...inc }
  if (!isPlanningFactsLocked(ex)) return merged
  merged.planningCore = ex.planningCore
  merged.planningDesignerDisplayName = ex.planningDesignerDisplayName
  return merged
}
