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

export function PlanningEngineBody({
  line,
  readiness,
  readinessLoading,
  onPatch,
  onLock,
}: PlanningEngineBodyProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <SectionBoardAllocation
        line={line}
        readiness={readiness}
        readinessLoading={readinessLoading}
        onPatch={onPatch}
      />
      <SectionSmartMatch line={line} readiness={readiness} onPatch={onPatch} />
      <SectionUpsAndSpec line={line} onPatch={onPatch} />
      <SectionBatchDecision line={line} onPatch={onPatch} onLock={onLock} />
    </div>
  )
}
