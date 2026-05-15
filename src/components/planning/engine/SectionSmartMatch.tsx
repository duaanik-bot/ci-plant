'use client'

import { CardSection } from '@/components/design-system/CardSection'
import type { PlanningEngineLine, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  onPatch: SectionPatchFn
}

export function SectionSmartMatch({ line: _line, onPatch: _onPatch }: Props) {
  return <CardSection title="SMART MATCH">stub</CardSection>
}
