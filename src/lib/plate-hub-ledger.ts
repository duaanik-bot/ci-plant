import { HUB_ZONE } from '@/lib/plate-hub-events'
import type { HubPlateSize } from '@/lib/plate-size'

export type LedgerZoneKey =
  | 'incoming_triage'
  | 'ctp_queue'
  | 'outside_vendor'
  | 'live_inventory'
  | 'custody_floor'
  | 'other'

const LEDGER_ZONE_BADGE: Record<LedgerZoneKey, string> = {
  incoming_triage: 'border-amber-600/70 bg-amber-950/60 text-amber-100',
  ctp_queue: 'border-amber-500/60 bg-amber-950/40 text-amber-200',
  outside_vendor: 'border-violet-500/70 bg-violet-950/50 text-violet-100',
  live_inventory: 'border-emerald-600/70 bg-emerald-950/40 text-emerald-100',
  custody_floor: 'border-orange-500/70 bg-orange-950/40 text-orange-100',
  other: 'border-zinc-600 bg-zinc-900 text-zinc-300',
}

export function ledgerZoneBadgeClass(zoneKey: LedgerZoneKey): string {
  return LEDGER_ZONE_BADGE[zoneKey] ?? LEDGER_ZONE_BADGE.other
}

export function ledgerZoneLabel(zoneKey: LedgerZoneKey): string {
  switch (zoneKey) {
    case 'incoming_triage':
      return HUB_ZONE.INCOMING_TRIAGE
    case 'ctp_queue':
      return HUB_ZONE.CTP_QUEUE
    case 'outside_vendor':
      return HUB_ZONE.OUTSIDE_VENDOR
    case 'live_inventory':
      return HUB_ZONE.LIVE_INVENTORY
    case 'custody_floor':
      return HUB_ZONE.CUSTODY_FLOOR
    default:
      return HUB_ZONE.OTHER
  }
}

export function ledgerZoneKeyForRequirement(row: {
  triageChannel: string | null
  status: string
}): LedgerZoneKey {
  if (row.status === 'READY_ON_FLOOR') return 'custody_floor'
  if (row.triageChannel === 'inhouse_ctp' && row.status === 'ctp_internal_queue') {
    return 'ctp_queue'
  }
  if (row.triageChannel === 'outside_vendor' && row.status === 'awaiting_vendor_delivery') {
    return 'outside_vendor'
  }
  if (
    row.triageChannel == null &&
    ['pending', 'ctp_notified', 'plates_ready'].includes(row.status)
  ) {
    return 'incoming_triage'
  }
  return 'other'
}

export function ledgerZoneKeyForPlate(row: { status: string }): LedgerZoneKey {
  if (row.status === 'READY_ON_FLOOR') return 'custody_floor'
  if (['ready', 'returned', 'in_stock'].includes(row.status)) return 'live_inventory'
  return 'other'
}

/** Wire payload row for Master Ledger + audit context hints. */
export type PlateHubLedgerRowJson = {
  entity: 'requirement' | 'plate'
  id: string
  jobId: string
  displayCode: string
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  poLineId: string | null
  zoneKey: LedgerZoneKey
  zoneLabel: string
  zoneBadgeClass: string
  plateSize: HubPlateSize | null
  plateColours: string[]
  coloursRequired: number
  platesInRackCount: number | null
  lastStatusUpdatedAt: string
  /** Record creation time (requirement / plate store) — used for Excel lead-time only. */
  ledgerEntryAt: string
  statusLabel: string
  partialRemake?: boolean
  custodySource?: 'ctp' | 'vendor' | 'rack'
  jobCardId: string | null
}
