import type { PoLineItem } from '@prisma/client'
import { poToolingSignalCounts, type DyeToolingRow } from '@/lib/po-tooling-critical'

export type PoReadiness = {
  tooling: { g: number; y: number; r: number }
  material: { grey: number; blue: number; green: number }
  production: { grey: number; blue: number; green: number }
}

function materialBucket(status: string): 'grey' | 'blue' | 'green' {
  const x = (status ?? '').trim().toLowerCase()
  if (x === 'received') return 'green'
  if (x === 'on_order' || x === 'dispatched' || x === 'paper_ordered') return 'blue'
  return 'grey'
}

function productionBucket(planningStatus: string): 'grey' | 'blue' | 'green' {
  const x = (planningStatus ?? '').trim().toLowerCase()
  if (x === 'in_production' || x === 'closed') return 'green'
  if (x === 'pending') return 'grey'
  return 'blue'
}

export function computePoReadiness(
  lines: PoLineItem[],
  dyeById: Map<string, DyeToolingRow>,
): PoReadiness {
  const tooling = poToolingSignalCounts(lines, dyeById)
  const material = { grey: 0, blue: 0, green: 0 }
  const production = { grey: 0, blue: 0, green: 0 }
  for (const li of lines) {
    material[materialBucket(li.materialProcurementStatus)]++
    production[productionBucket(li.planningStatus)]++
  }
  return { tooling, material, production }
}
