/** PO “smart delivery” — calendar days from local today (not PO date). */

export type PoLineScheduleInput = {
  cartonName: string
  quantity: string
  cartonId: string
  dieMasterId: string
  toolingUnlinked: boolean
}

export function todayPlusCalendarDays(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** True when line needs new tooling (not a simple repeat). */
export function lineNeedsNewTooling(l: PoLineScheduleInput): boolean {
  return (
    !l.cartonId ||
    l.toolingUnlinked ||
    !String(l.dieMasterId || '').trim()
  )
}

export type DeliveryScheduleKind = 'repeat' | 'new_tooling'

/**
 * Lines with carton name + positive qty participate.
 * Any “new tooling” line → +12d; otherwise all repeat → +7d.
 */
export function computeSuggestedDelivery(
  lines: PoLineScheduleInput[],
): { ymd: string; kind: DeliveryScheduleKind } | null {
  const valid = lines.filter(
    (l) => l.cartonName.trim() && l.quantity.trim() && Number(l.quantity) > 0,
  )
  if (valid.length === 0) return null
  const anyNew = valid.some(lineNeedsNewTooling)
  if (anyNew) {
    return { ymd: todayPlusCalendarDays(12), kind: 'new_tooling' }
  }
  return { ymd: todayPlusCalendarDays(7), kind: 'repeat' }
}
