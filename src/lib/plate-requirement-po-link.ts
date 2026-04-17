/** Matches legacy `cartonName` labels from `createPlateRequirementFromPoLine`: "… · PO line <uuid>". */
const PO_LINE_UUID_IN_LABEL =
  /PO line ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

export function extractPoLineIdFromCartonLabel(cartonName: string | null | undefined): string | null {
  if (!cartonName?.trim()) return null
  const m = cartonName.match(PO_LINE_UUID_IN_LABEL)
  return m?.[1]?.trim() || null
}
