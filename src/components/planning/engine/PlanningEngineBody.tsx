'use client'

import type { PlanningEngineLine, SectionPatchFn } from './types'
import { SectionBoardAllocation } from './SectionBoardAllocation'
import { SectionSmartMatch } from './SectionSmartMatch'
import { SectionUpsAndSpec } from './SectionUpsAndSpec'
import { SectionBatchDecision } from './SectionBatchDecision'

export type PlanningEngineBodyProps = {
  line: PlanningEngineLine
  onPatch: SectionPatchFn
  onLock: () => Promise<void>
}

export function PlanningEngineBody({ line, onPatch, onLock }: PlanningEngineBodyProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <SectionBoardAllocation line={line} onPatch={onPatch} />
      <SectionSmartMatch line={line} onPatch={onPatch} />
      <SectionUpsAndSpec line={line} onPatch={onPatch} />
      <SectionBatchDecision line={line} onPatch={onPatch} onLock={onLock} />
    </div>
  )
}
