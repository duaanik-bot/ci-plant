export type ProcurementSuggestion = {
  suggestedKg: number
  coversDays: number
  basis: 'reorder_level' | 'consumption'
}

const COVER_DAYS_TARGET = 45
const COVER_DAYS_MAX = 90

export function computeSuggestion(row: {
  shortage_sheets: number
  incoming_sheets: number
  reorder_level: number
  daysOfCover: number | null
  packet_weight: number
}): ProcurementSuggestion | null {
  const netShortage = Math.max(0, row.shortage_sheets - row.incoming_sheets)
  if (netShortage <= 0) return null

  const basis: ProcurementSuggestion['basis'] =
    row.reorder_level > netShortage ? 'reorder_level' : 'consumption'

  const baseSheets = Math.max(row.reorder_level, netShortage)
  // Cap at 90-day buffer: if daysOfCover after ordering would exceed 90, reduce.
  const dailyConsumption =
    row.daysOfCover && row.daysOfCover > 0
      ? netShortage / Math.max(row.daysOfCover, 1)
      : 0
  const maxSheets =
    dailyConsumption > 0
      ? Math.ceil(dailyConsumption * COVER_DAYS_MAX)
      : baseSheets

  const suggestedSheets = Math.min(baseSheets, maxSheets)
  const suggestedKg = suggestedSheets * row.packet_weight
  const coversDays =
    dailyConsumption > 0
      ? Math.round(suggestedSheets / dailyConsumption)
      : COVER_DAYS_TARGET

  return { suggestedKg, coversDays, basis }
}
