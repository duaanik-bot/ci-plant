import { hubPlateBadgeCount } from '@/lib/hub-plate-card-ui'

/** Physical / active channel count for rack & custody plate cards (no UI badge cap). */
export function hubInventoryChannelCount(p: {
  platesInRackCount?: number | null
  numberOfColours?: number | null
  totalPlates?: number | null
  plateColours?: string[] | null
}): number {
  if (p.platesInRackCount != null && p.platesInRackCount >= 0) return p.platesInRackCount
  return hubPlateBadgeCount({
    numberOfColours: p.numberOfColours,
    totalPlates: p.totalPlates,
    plateColours: p.plateColours,
  })
}

export function hubZonePlateVolumeTriage(row: {
  newPlatesNeeded: number
  plateColours: string[]
}): number {
  return hubPlateBadgeCount({
    totalPlates: row.newPlatesNeeded,
    plateColours: row.plateColours,
  })
}

/** CTP / vendor queue: honours shop-floor dimmed channels via `shopfloorActiveColourCount`. */
export function hubZonePlateVolumeShopfloorJob(row: {
  shopfloorActiveColourCount?: number
  numberOfColours?: number
  newPlatesNeeded?: number
  plateColours: string[]
}): number {
  if (row.shopfloorActiveColourCount != null && row.shopfloorActiveColourCount >= 0) {
    return row.shopfloorActiveColourCount
  }
  return hubPlateBadgeCount({
    numberOfColours: row.numberOfColours,
    totalPlates: row.newPlatesNeeded,
    plateColours: row.plateColours,
  })
}

export function hubZonePlateVolumeInventoryCard(p: {
  platesInRackCount?: number | null
  numberOfColours?: number | null
  totalPlates?: number | null
  plateColours?: string[] | null
}): number {
  return hubInventoryChannelCount(p)
}

export function hubZonePlateVolumeCustodyCard(c: {
  kind: 'requirement' | 'plate'
  platesInRackCount?: number | null
  numberOfColours?: number | null
  newPlatesNeeded?: number | null
  totalPlates?: number | null
  plateColours: string[]
}): number {
  if (c.kind === 'plate') {
    return hubInventoryChannelCount({
      platesInRackCount: c.platesInRackCount,
      numberOfColours: c.numberOfColours,
      totalPlates: c.totalPlates,
      plateColours: c.plateColours,
    })
  }
  return hubPlateBadgeCount({
    numberOfColours: c.numberOfColours,
    totalPlates: c.newPlatesNeeded,
    plateColours: c.plateColours,
  })
}

export function calculateZoneMetrics<T>(
  cards: T[],
  plateVolume: (card: T) => number,
): { jobCount: number; plateCount: number } {
  let plateCount = 0
  for (const card of cards) {
    plateCount += plateVolume(card)
  }
  return { jobCount: cards.length, plateCount }
}

/** Per-row plate volume for Master Ledger (matches board logic; inventory uses physical channel count). */
export function ledgerRowPlateVolume(r: {
  entity: 'requirement' | 'plate'
  platesInRackCount: number | null
  coloursRequired: number
  plateColours: string[]
}): number {
  if (r.entity === 'plate') {
    return hubInventoryChannelCount({
      platesInRackCount: r.platesInRackCount,
      numberOfColours: r.coloursRequired,
      totalPlates: r.coloursRequired,
      plateColours: r.plateColours,
    })
  }
  return Math.max(0, r.coloursRequired ?? 0)
}
