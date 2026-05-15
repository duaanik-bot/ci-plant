'use client'

import { CardSection } from '@/components/design-system/CardSection'
import type { PlanningEngineLine, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  onPatch: SectionPatchFn
}

export function SectionBoardAllocation({ line: _line, onPatch: _onPatch }: Props) {
  return <CardSection title="BOARD ALLOCATION">stub</CardSection>
}
