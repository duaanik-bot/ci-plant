import { CUSTODY_ON_FLOOR } from '@/lib/inventory-hub-custody'

export type EmbossOperationalLabel = 'Ready' | 'In-Use' | 'Repair' | 'Scrap'

const REPAIR_CONDITIONS = new Set(['Worn', 'Needs Cleaning', 'Damaged', 'Poor', 'Destroyed'])

export function embossOperationalStatus(params: {
  active: boolean
  scrappedAt: Date | null
  condition: string
  custodyStatus: string
  issuedMachineId: string | null
}): EmbossOperationalLabel {
  if (!params.active || params.scrappedAt) return 'Scrap'
  const cond = params.condition?.trim() ?? ''
  if (REPAIR_CONDITIONS.has(cond)) return 'Repair'
  if (params.custodyStatus === CUSTODY_ON_FLOOR || params.issuedMachineId) return 'In-Use'
  return 'Ready'
}

export function embossOperationalIsRose(params: {
  active: boolean
  scrappedAt: Date | null
  condition: string
}): boolean {
  if (!params.active || params.scrappedAt) return true
  const cond = params.condition?.trim() ?? ''
  return REPAIR_CONDITIONS.has(cond)
}
