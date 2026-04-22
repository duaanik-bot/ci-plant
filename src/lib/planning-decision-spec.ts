/**
 * Planning Decision Layer — immutable handoff payload to AW Queue (stored in `po_line_items.specOverrides.planningCore`).
 */

export const PLANNING_DESIGNERS = {
  avneet_singh: 'Avneet Singh',
  shamsher_inder: 'Shamsher Inder',
} as const

export type PlanningDesignerKey = keyof typeof PLANNING_DESIGNERS

export type PlanningSetIdMode = 'auto' | 'manual'

export type PlanningLayoutType = 'single' | 'gang'

/** Mix-set / line batch workflow in Planning (decision only; no change to sheet math). */
export type PlanningBatchStatus =
  | 'draft'
  | 'ready'
  | 'hold'
  | 'approved_for_artwork'
  | 'released_to_production'

export type PlanningCore = {
  /** ISO timestamp — once set, AW Queue treats UPS / set / designer as authoritative unless recalled */
  savedAt?: string | null
  designerKey?: PlanningDesignerKey | null
  /** Units per sheet (manual) */
  ups?: number | null
  /** Display label e.g. "720×1020 mm" */
  actualSheetSizeLabel?: string | null
  /** 0–100 sheet utilization vs parent sheet */
  productionYieldPct?: number | null
  /** Gang / mix-set: shared id across linked lines */
  masterSetId?: string | null
  mixSetMemberIds?: string[] | null
  setIdMode?: PlanningSetIdMode | null
  /** Resolved set # written to line.setNumber on save when auto */
  resolvedSetNumber?: string | null
  layoutType?: PlanningLayoutType | null
  /** Batch decision engine — kept in planningCore, excluded from planning facts lock snapshot. */
  batchStatus?: PlanningBatchStatus | null
  batchHoldReason?: string | null
  /** When `batchStatus` is `hold`, status to restore on Resume. */
  batchStatusBeforeHold?: PlanningBatchStatus | null
  batchDecisionUpdatedAt?: string | null
}

export function readPlanningCore(spec: Record<string, unknown> | null | undefined): PlanningCore {
  const raw = spec?.planningCore
  if (!raw || typeof raw !== 'object') return {}
  const o = raw as Record<string, unknown>
  const designerKey = o.designerKey
  const batchStatusRaw = o.batchStatus
  const batchStatus: PlanningBatchStatus | null | undefined =
    batchStatusRaw === 'draft' ||
    batchStatusRaw === 'ready' ||
    batchStatusRaw === 'hold' ||
    batchStatusRaw === 'approved_for_artwork' ||
    batchStatusRaw === 'released_to_production'
      ? batchStatusRaw
      : batchStatusRaw === null
        ? null
        : undefined
  const batchStatusBeforeRaw = o.batchStatusBeforeHold
  const batchStatusBeforeHold: PlanningBatchStatus | null | undefined =
    batchStatusBeforeRaw === 'draft' ||
    batchStatusBeforeRaw === 'ready' ||
    batchStatusBeforeRaw === 'hold' ||
    batchStatusBeforeRaw === 'approved_for_artwork' ||
    batchStatusBeforeRaw === 'released_to_production'
      ? batchStatusBeforeRaw
      : batchStatusBeforeRaw === null
        ? null
        : undefined
  return {
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : o.savedAt === null ? null : undefined,
    designerKey:
      designerKey === 'avneet_singh' || designerKey === 'shamsher_inder'
        ? designerKey
        : undefined,
    ups: typeof o.ups === 'number' && Number.isFinite(o.ups) ? o.ups : null,
    actualSheetSizeLabel: typeof o.actualSheetSizeLabel === 'string' ? o.actualSheetSizeLabel : null,
    productionYieldPct:
      typeof o.productionYieldPct === 'number' && Number.isFinite(o.productionYieldPct)
        ? o.productionYieldPct
        : null,
    masterSetId: typeof o.masterSetId === 'string' ? o.masterSetId : null,
    mixSetMemberIds: Array.isArray(o.mixSetMemberIds)
      ? o.mixSetMemberIds.filter((x): x is string => typeof x === 'string')
      : null,
    setIdMode: o.setIdMode === 'auto' || o.setIdMode === 'manual' ? o.setIdMode : null,
    resolvedSetNumber: typeof o.resolvedSetNumber === 'string' ? o.resolvedSetNumber : null,
    layoutType: o.layoutType === 'single' || o.layoutType === 'gang' ? o.layoutType : null,
    batchStatus,
    batchHoldReason:
      typeof o.batchHoldReason === 'string'
        ? o.batchHoldReason
        : o.batchHoldReason === null
          ? null
          : undefined,
    batchStatusBeforeHold,
    batchDecisionUpdatedAt:
      typeof o.batchDecisionUpdatedAt === 'string' ? o.batchDecisionUpdatedAt : undefined,
  }
}

export function planningHandoffComplete(spec: Record<string, unknown> | null | undefined): boolean {
  const c = readPlanningCore(spec)
  return !!c.savedAt?.trim() && !!c.designerKey
}

/** Simple utilization: n identical blanks on a parent sheet (same orientation). */
export function computeSheetUtilization(args: {
  blankLengthMm: number
  blankWidthMm: number
  sheetLengthMm: number
  sheetWidthMm: number
  ups: number
}): { yieldPct: number; sheetsRequiredHint: number } {
  const { blankLengthMm: L, blankWidthMm: W, sheetLengthMm: SL, sheetWidthMm: SW, ups } = args
  const u = Math.max(1, Math.floor(ups))
  if (![L, W, SL, SW].every((x) => Number.isFinite(x) && x > 0)) {
    return { yieldPct: 0, sheetsRequiredHint: 0 }
  }
  const blankArea = L * W
  const sheetArea = SL * SW
  const used = blankArea * u
  const yieldPct = Math.min(100, Math.round((used / sheetArea) * 1000) / 10)
  return { yieldPct, sheetsRequiredHint: 0 }
}

export function formatSheetSizeMm(l: number, w: number): string {
  return `${Math.round(l)}×${Math.round(w)} mm`
}

export function generateMasterSetId(): string {
  const t = Date.now().toString(36).toUpperCase()
  const r = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `MIX-${t}-${r}`
}

/** Next industry-style set id within a PO (SET-001 …) based on existing line set numbers. */
export function suggestNextAutoSetNumber(existingSetNumbers: (string | null | undefined)[]): string {
  let max = 0
  for (const s of existingSetNumbers) {
    const m = String(s ?? '').match(/(\d+)/g)
    if (m?.length) {
      const n = parseInt(m[m.length - 1]!, 10)
      if (Number.isFinite(n)) max = Math.max(max, n)
    }
  }
  const next = max + 1
  return `SET-${String(next).padStart(3, '0')}`
}
