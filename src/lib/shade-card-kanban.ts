import { shadeCardAgeTier } from '@/lib/shade-card-age'

export type ShadeKanbanColumnId = 'in_stock' | 'on_floor' | 'reverify' | 'expired'

/** Visual column: age tiers (expired / re-verify) override custody for compliance lanes. */
export function shadeCardKanbanColumn(row: {
  currentAgeMonths?: number | null
  custodyStatus?: string | null
}): ShadeKanbanColumnId {
  const tier = shadeCardAgeTier(row.currentAgeMonths ?? null)
  if (tier === 'expired') return 'expired'
  if (tier === 'reverify') return 'reverify'
  if (row.custodyStatus === 'on_floor') return 'on_floor'
  return 'in_stock'
}

export function shadeCardAgeLifecyclePercent(ageMonths: number | null): number {
  if (ageMonths == null || !Number.isFinite(ageMonths)) return 0
  return Math.min(100, Math.max(0, (ageMonths / 12) * 100))
}

/** Normalize holder strings like "b12" / "b-12" → "B-12" for floor location chips. */
export function formatKanbanLocationCode(raw: string): string {
  const t = raw.trim()
  if (!t) return t
  const compact = /^([a-zA-Z])\s*[-–]?\s*(\d{1,4})$/i.exec(t)
  if (compact) return `${compact[1].toUpperCase()}-${compact[2]}`
  const u = t.toUpperCase()
  return u.length <= 14 ? u : `${u.slice(0, 12)}…`
}

export function kanbanLocationCode(row: {
  shadeCode: string
  currentHolder?: string | null
  custodyStatus?: string | null
}): string {
  const h = row.currentHolder?.trim()
  if (h) {
    return formatKanbanLocationCode(h)
  }
  if (row.custodyStatus === 'in_stock') return 'RACK'
  if (row.custodyStatus === 'on_floor') return 'FLOOR'
  return row.shadeCode
}
