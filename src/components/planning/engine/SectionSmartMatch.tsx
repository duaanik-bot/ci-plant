'use client'

import { CardSection } from '@/components/design-system/CardSection'
import type { PlanningEngineLine, PlanningEngineReadiness, SectionPatchFn } from './types'

type Props = {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
  onPatch: SectionPatchFn
}

export function SectionSmartMatch({ line: _line, readiness: _readiness, onPatch: _onPatch }: Props) {
  return <CardSection title="SMART MATCH">stub</CardSection>
}
