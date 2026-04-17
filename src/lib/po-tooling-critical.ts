import type { PoLineItem } from '@prisma/client'
import { classifyPoToolingSignal, type DieStatusSnapshot } from '@/lib/po-tooling-signal'

export type DyeToolingRow = {
  id: string
  custodyStatus: string
  condition: string
  dyeNumber: number
  location: string | null
  hubStatusFlag: string | null
}

export function dyeMapFromRows(dyes: DyeToolingRow[]): Map<string, DyeToolingRow> {
  return new Map(dyes.map((d) => [d.id, d]))
}

function toSnapshot(d: DyeToolingRow): DieStatusSnapshot {
  return {
    custodyStatus: d.custodyStatus,
    condition: d.condition,
    dyeNumber: d.dyeNumber,
    location: d.location,
    hubStatusFlag: d.hubStatusFlag,
  }
}

/** True if this PO line shows a red tooling signal (missing / new tooling / bad die data). */
export function isPoLineToolingRed(li: PoLineItem, dyeById: Map<string, DyeToolingRow>): boolean {
  const input = {
    cartonName: li.cartonName,
    quantity: String(li.quantity),
    cartonId: li.cartonId ?? '',
    dieMasterId: li.dieMasterId ?? '',
    toolingUnlinked: !(li.cartonId && li.dieMasterId),
  }
  const id = String(input.dieMasterId ?? '').trim()
  const d = id ? dyeById.get(id) : undefined
  const snap = d ? toSnapshot(d) : undefined
  return classifyPoToolingSignal(input, snap) === 'red'
}

export function poHasCriticalTooling(
  lines: PoLineItem[],
  dyeById: Map<string, DyeToolingRow>,
): boolean {
  return lines.some((li) => isPoLineToolingRed(li, dyeById))
}

/** Per-line tooling signals for dashboard readiness (G/Y/R counts). */
export function poToolingSignalCounts(
  lines: PoLineItem[],
  dyeById: Map<string, DyeToolingRow>,
): { g: number; y: number; r: number } {
  let g = 0
  let y = 0
  let r = 0
  for (const li of lines) {
    const input = {
      cartonName: li.cartonName,
      quantity: String(li.quantity),
      cartonId: li.cartonId ?? '',
      dieMasterId: li.dieMasterId ?? '',
      toolingUnlinked: !(li.cartonId && li.dieMasterId),
    }
    const id = String(input.dieMasterId ?? '').trim()
    const d = id ? dyeById.get(id) : undefined
    const snap = d ? toSnapshot(d) : undefined
    const sig = classifyPoToolingSignal(input, snap)
    if (sig === 'green') g++
    else if (sig === 'yellow') y++
    else r++
  }
  return { g, y, r }
}
