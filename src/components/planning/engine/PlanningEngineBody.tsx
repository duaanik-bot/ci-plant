'use client'

import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'
import { SectionBoardAllocation } from './SectionBoardAllocation'
import { SectionSmartMatch } from './SectionSmartMatch'
import { SectionUpsAndSpec } from './SectionUpsAndSpec'
import { SectionBatchDecision } from './SectionBatchDecision'

export type PlanningEngineBodyProps = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  readinessLoading: boolean
  onPatch: SectionPatchFn
  onLock: () => Promise<void>
  /** Link the line to a board material — drives Board allocation + Smart Match selection. */
  onSelectBoard?: (materialId: string) => Promise<void>
  /**
   * Reserve the matched material against this line's requirement.
   * Wires to POST /api/planning/po-lines/:id/reserve-material with actionType='reserve'.
   * When undefined the Reserve button is hidden.
   */
  onReserve?: () => Promise<void>
  /**
   * Raise a draft Purchase Request for the shortage on this line.
   * When undefined the Raise PR button is hidden in the shortage banner.
   */
  onRaisePR?: () => Promise<void>
}

/**
 * Layout — single full-width vertical stack in planning-decision order:
 *
 *   1. Sheet metrics (UPS & spec)    — confirm the carton spec first
 *   2. Board allocation              — pick board type, GSM, size, wastage
 *   3. Smart match                   — ranked warehouse stock matches
 *   4. Batch decision                — layout, set number, press, lock
 *
 * All four sections are wrapped in React.memo internally — re-renders are
 * isolated to the section whose props actually changed.
 */
export function PlanningEngineBody({
  line,
  readiness,
  readinessLoading,
  onPatch,
  onLock,
  onSelectBoard,
  onReserve,
  onRaisePR,
}: PlanningEngineBodyProps) {
  return (
    <div className="space-y-4">
      <SectionUpsAndSpec line={line} onPatch={onPatch} />
      <SectionBoardAllocation
        line={line}
        readiness={readiness}
        readinessLoading={readinessLoading}
        onPatch={onPatch}
        onSelectBoard={onSelectBoard}
        onReserve={onReserve}
        onRaisePR={onRaisePR}
      />
      <SectionSmartMatch
        line={line}
        readiness={readiness}
        onPatch={onPatch}
        onSelectBoard={onSelectBoard}
      />
      <SectionBatchDecision line={line} onPatch={onPatch} onLock={onLock} />
    </div>
  )
}
