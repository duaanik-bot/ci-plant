import type { PlanningGridLine, PlanningLineFieldPatch } from '@/components/planning/PlanningDecisionGrid'

/**
 * Subset of the material readiness payload (fetched by the drawer
 * from /api/planning/po-lines/:id/reserve-material) that the engine
 * sections need. Defined locally so sections don't depend on the
 * drawer's internal type.
 */
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
  /** Ranked board matches the readiness API already computes (strict). */
  suggestedBoardOptions?: PlanningEngineBoardOption[]
  /** Looser fallback matches when no strict option exists. */
  closestAvailableOptions?: PlanningEngineBoardOption[]
}

/** Subset of the readiness board-option shape the SMART MATCH card renders. */
export type PlanningEngineBoardOption = {
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  size: string
  freeSheets: number
  availableSheets: number
  requiredParentSheets: number
  shortageParentSheets: number
  wastagePct: number
  yieldPct: number
  cutsPerSheet: number
  matchType: string
  status: 'Ready' | 'Partial' | 'Shortage'
  tags: string[]
  gsmDelta: number | null
  matchScorePct?: number | null
  reason?: string | null
  boardClassification?: string | null
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
    /** Allocated sheets × UPS (req-3 expected yield). */
    expectedYieldUnits?: number | null
    /** Allocated/free sheets − total required (req-3 balance after allocation). */
    balanceAfterAllocation?: number | null
  }
  /** Separated sheet spec (length/width/unit/cut/parent/child sizes). */
  sheetSpec?: {
    lengthMm: number | null
    widthMm: number | null
    unit: 'mm' | 'inch'
    cutType: number | null
    parentSize: string | null
    childSize: string | null
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
    releaseGuard?: { canRelease: boolean; reason: string | null }
    lockedAt?: string | null
    lockedByName?: string | null
  }
}

export type SectionPatchFn = (patch: PlanningLineFieldPatch) => Promise<boolean>
