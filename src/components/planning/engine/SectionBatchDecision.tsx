'use client'

import { CardSection } from '@/components/design-system/CardSection'
import type { PlanningEngineLine, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  onPatch: SectionPatchFn
  onLock: () => Promise<void>
}

export function SectionBatchDecision({ line: _line, onPatch: _onPatch, onLock: _onLock }: Props) {
  return <CardSection title="BATCH DECISION">stub</CardSection>
}
