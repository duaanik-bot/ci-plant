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
}

/**
 * Layout — material flows top-to-bottom so the eye lands on the most
 * decision-critical block first, then spec, then commit.
 *
 *   ┌──────────────── Board allocation ────────────────┐  (full width)
 *   ├─── UPS & spec ───┬─── Batch decision ────────────┤  (2-col)
 *   └──────────────── Smart match ─────────────────────┘  (full width)
 *
 * Smart match sits at the bottom because its content varies wildly —
 * empty (compact guidance) or 3–4 rich cards (deserves full width).
 */
export function PlanningEngineBody({
  line,
  readiness,
  readinessLoading,
  onPatch,
  onLock,
}: PlanningEngineBodyProps) {
  return (
    <div className="space-y-4">
      <SectionBoardAllocation
        line={line}
        readiness={readiness}
        readinessLoading={readinessLoading}
        onPatch={onPatch}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionUpsAndSpec line={line} onPatch={onPatch} />
        <SectionBatchDecision line={line} onPatch={onPatch} onLock={onLock} />
      </div>
      <SectionSmartMatch line={line} readiness={readiness} onPatch={onPatch} />
    </div>
  )
}
