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
   * Release the reservation held against this line (full unreserve).
   * When undefined the Unreserve button is hidden.
   */
  onUnreserve?: () => Promise<void>
  /**
   * Raise a draft Purchase Request for the shortage on this line.
   * When undefined the Raise PR button is hidden in the shortage banner.
   */
  onRaisePR?: () => Promise<void>
}

/**
 * Layout — board discovery flows top-to-bottom (allocate, then the ranked
 * smart-match suggestions that feed it), with spec + commit last.
 *
 *   ┌──────────────── Board allocation ────────────────┐  (full width)
 *   ├──────────────── Smart match ─────────────────────┤  (full width)
 *   └─── Sheet metrics ─┬─── Batch decision ───────────┘  (2-col)
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
  onUnreserve,
  onRaisePR,
}: PlanningEngineBodyProps) {
  return (
    <div className="space-y-4">
      <SectionBoardAllocation
        line={line}
        readiness={readiness}
        readinessLoading={readinessLoading}
        onPatch={onPatch}
        onSelectBoard={onSelectBoard}
        onReserve={onReserve}
        onUnreserve={onUnreserve}
        onRaisePR={onRaisePR}
      />
      <SectionSmartMatch
        line={line}
        readiness={readiness}
        onPatch={onPatch}
        onSelectBoard={onSelectBoard}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionUpsAndSpec line={line} onPatch={onPatch} />
        <SectionBatchDecision line={line} onPatch={onPatch} onLock={onLock} />
      </div>
    </div>
  )
}
