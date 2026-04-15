/** Per-card physical units for Die / Emboss hub capacity (dies use stock count). */
export function toolingCardUnits(row: {
  kind: 'die' | 'emboss'
  currentStock?: number | null
}): number {
  if (row.kind === 'die') return Math.max(1, row.currentStock ?? 1)
  return 1
}

export function calculateToolingZoneMetrics<T>(
  cards: T[],
  unitsOf: (c: T) => number,
): { jobCount: number; unitCount: number } {
  let unitCount = 0
  for (const c of cards) {
    unitCount += unitsOf(c)
  }
  return { jobCount: cards.length, unitCount }
}
