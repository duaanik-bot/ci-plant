import type { PlanningGridLine, PlanningLineFieldPatch } from '@/components/planning/PlanningDecisionGrid'

/**
 * Subset of the material readiness payload (fetched by the drawer
 * from /api/planning/po-lines/:id/reserve-material) that the engine
 * sections need. Defined locally so sections don't depend on the
 * drawer's internal type.
 */
export type PlanningEngineBoardOption = {
  materialId: string
  materialCode: string
  boardType: string | null
  boardClassification: string | null
  gsm: number | null
  size: string
  availableSheets: number
  reservedSheets: number
  freeSheets: number
  cutsPerSheet: number
  requiredParentSheets: number
  shortageParentSheets: number
  wastagePct: number
  sizeDeviationPct?: number
  fitScore?: number
  yieldPct: number
  orientation: 'LxW' | 'WxL'
  matchType:
    | 'Cut Fit'
    | 'Direct Size'
    | 'Special Cut'
    | 'GSM Tolerance'
    | 'Compatible Size'
    | 'Fallback Option'
  status: 'Ready' | 'Partial' | 'Shortage'
  tags: string[]
  gsmDelta: number | null
  matchRank?: number
  isLeftover?: boolean
  boardMatchMode?: 'exact' | 'cross_field' | 'fallback'
}

export type PlanningEngineReadiness = {
  materialId: string | null
  materialCode: string | null
  boardType: string | null
  boardClassification: string | null
  size: string | null
  gsm: number | null
  requiredSheets: number
  availableSheets: number
  reservedSheets: number
  freeSheets?: number
  incomingSheets: number
  shortageSheets: number
  prId?: string | null
  prStatus: string
  grnEta: string | null
  status?: 'green' | 'yellow' | 'red' | null
  suggestedBoardOptions?: PlanningEngineBoardOption[]
  closestAvailableOptions?: PlanningEngineBoardOption[]
}

/**
 * View model the four engine sections consume. The drawer is responsible
 * for adapting its raw line + readiness fetches into this shape so each
 * section stays small and testable.
 */
export type PlanningEngineLine = PlanningGridLine & {
  /** UPS & sheet spec extras — derived from spec + material queue. */
  upsAndSpec?: {
    ups: number | null
    upsSource: 'auto' | 'manual' | null
    sheetYieldPct: number | null
    makeReady?: {
      total: number
      base: number
      colours?: { count: number; perColour: number } | null
      uv?: number | null
    } | null
    bpi?: { status: 'Optimal' | 'Suboptimal'; marginInr: number; setupInr: number } | null
  }
  /** Smart-match suggestions emitted by the scoring engine (Phase 3 wires the data). */
  smartMatch?: {
    boardMatchConfidence: number
    materialCode: string | null
    matchedOn: string | null
    suggestions: Array<{
      label: string
      tier: 'High' | 'Medium' | 'Low'
      composite: number
      sizeScore: number
      wasteScore: number
      urgencyScore: number
      toolScore: number
      poRefs: string[]
      linesIncluded: number
      totalPcs: number
      avgYieldPct: number
      totalSheets: number
    }>
  }
  /** Batch decision extras. */
  batchDecision?: {
    status: 'Ready' | 'Draft' | 'Hold' | 'ApprovedAW' | 'Released' | 'Locked'
    layoutType: 'Gang' | 'Single'
    setNumber: string | null
    setNumberAuto: boolean
    designerOptions: Array<{ id: string; name: string }>
    designerId: string | null
    pressAssignment?: {
      code: string
      deckLabel: string
      size: string
      loadPct: number
      runHours: number
      smartPicked: boolean
    } | null
    readinessFive?: { allReady: boolean; blockers: string[] }
    lockedAt?: string | null
    lockedByName?: string | null
  }
}

export type SectionPatchFn = (patch: PlanningLineFieldPatch) => Promise<boolean>
