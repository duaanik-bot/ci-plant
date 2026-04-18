/** Timestamp / audit label for logistics mutations (Anik Dua signature). */
export const PROCUREMENT_LOGISTICS_AUDIT_ACTOR = 'Anik Dua'

export type LogisticsLane = 'mill_dispatched' | 'in_transit' | 'at_gate'

export type VendorPoLogisticsFields = {
  status: string
  dispatchedAt: Date | null
  logisticsStatus: string | null
  lrNumber: string | null
  vehicleNumber: string | null
  estimatedArrivalAt: Date | null
}

/** Effective lane for UI + staleness (mill → gate). Null when vendor PO is not dispatched. */
export function effectiveLogisticsLane(vpo: VendorPoLogisticsFields): LogisticsLane | null {
  if (vpo.status !== 'dispatched' || !vpo.dispatchedAt) return null
  const lr = vpo.lrNumber?.trim()
  const vh = vpo.vehicleNumber?.trim()
  const explicit = vpo.logisticsStatus?.trim().toLowerCase()
  if (explicit === 'at_gate') return 'at_gate'
  if (explicit === 'in_transit' || (Boolean(lr) && Boolean(vh))) return 'in_transit'
  return 'mill_dispatched'
}

/** In-transit shipment is stale when ETA was more than 6 hours ago. */
export function isInTransitStale(
  lane: LogisticsLane | null,
  estimatedArrivalAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (lane !== 'in_transit' || !estimatedArrivalAt) return false
  return now.getTime() - estimatedArrivalAt.getTime() > 6 * 3_600_000
}
