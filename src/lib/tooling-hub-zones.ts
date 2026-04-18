import {
  CUSTODY_AT_VENDOR,
  CUSTODY_HUB_CUSTODY_READY,
  CUSTODY_HUB_ENGRAVING_QUEUE,
  CUSTODY_HUB_TRIAGE,
  CUSTODY_IN_STOCK,
  CUSTODY_ON_FLOOR,
  CUSTODY_PREPARING_FOR_PRODUCTION,
} from '@/lib/inventory-hub-custody'

/** Die Hub — human-readable zone labels (event log + UI). */
export const DIE_HUB_ZONE = {
  INCOMING_TRIAGE: 'Incoming Triage',
  OUTSIDE_VENDOR: 'Outside Vendor',
  LIVE_INVENTORY: 'Live Inventory',
  CUSTODY_FLOOR: 'Custody Floor',
  ON_MACHINE_FLOOR: 'On machine floor',
  OTHER: 'Other',
} as const

/** Emboss Block Hub — human-readable zone labels. */
export const EMBOSS_HUB_ZONE = {
  INCOMING_TRIAGE: 'Incoming Triage',
  IN_HOUSE_ENGRAVING: 'In-House Engraving',
  LIVE_INVENTORY: 'Live Inventory',
  CUSTODY_FLOOR: 'Custody Floor',
  OTHER: 'Other',
} as const

export function dieHubZoneLabelFromCustody(status: string): string {
  switch (status) {
    case CUSTODY_HUB_TRIAGE:
      return DIE_HUB_ZONE.INCOMING_TRIAGE
    case CUSTODY_PREPARING_FOR_PRODUCTION:
      return 'Preparing for Production'
    case CUSTODY_AT_VENDOR:
      return DIE_HUB_ZONE.OUTSIDE_VENDOR
    case CUSTODY_IN_STOCK:
      return DIE_HUB_ZONE.LIVE_INVENTORY
    case CUSTODY_HUB_CUSTODY_READY:
      return DIE_HUB_ZONE.CUSTODY_FLOOR
    case CUSTODY_ON_FLOOR:
      return DIE_HUB_ZONE.ON_MACHINE_FLOOR
    default:
      return DIE_HUB_ZONE.OTHER
  }
}

export function embossHubZoneLabelFromCustody(status: string): string {
  switch (status) {
    case CUSTODY_HUB_TRIAGE:
      return EMBOSS_HUB_ZONE.INCOMING_TRIAGE
    case CUSTODY_PREPARING_FOR_PRODUCTION:
      return 'Preparing for Production'
    case CUSTODY_HUB_ENGRAVING_QUEUE:
      return EMBOSS_HUB_ZONE.IN_HOUSE_ENGRAVING
    case CUSTODY_IN_STOCK:
      return EMBOSS_HUB_ZONE.LIVE_INVENTORY
    case CUSTODY_HUB_CUSTODY_READY:
      return EMBOSS_HUB_ZONE.CUSTODY_FLOOR
    case CUSTODY_ON_FLOOR:
      return DIE_HUB_ZONE.ON_MACHINE_FLOOR
    default:
      return EMBOSS_HUB_ZONE.OTHER
  }
}

export type ToolingLedgerZoneKey =
  | 'incoming_triage'
  | 'outside_vendor'
  | 'engraving_queue'
  | 'live_inventory'
  | 'custody_floor'
  | 'on_machine'
  | 'other'

export function dieLedgerZoneKeyFromCustody(status: string): ToolingLedgerZoneKey {
  switch (status) {
    case CUSTODY_HUB_TRIAGE:
      return 'incoming_triage'
    case CUSTODY_PREPARING_FOR_PRODUCTION:
      return 'incoming_triage'
    case CUSTODY_AT_VENDOR:
      return 'outside_vendor'
    case CUSTODY_IN_STOCK:
      return 'live_inventory'
    case CUSTODY_HUB_CUSTODY_READY:
      return 'custody_floor'
    case CUSTODY_ON_FLOOR:
      return 'on_machine'
    default:
      return 'other'
  }
}

export function embossLedgerZoneKeyFromCustody(status: string): ToolingLedgerZoneKey {
  switch (status) {
    case CUSTODY_HUB_TRIAGE:
      return 'incoming_triage'
    case CUSTODY_HUB_ENGRAVING_QUEUE:
      return 'engraving_queue'
    case CUSTODY_IN_STOCK:
      return 'live_inventory'
    case CUSTODY_HUB_CUSTODY_READY:
      return 'custody_floor'
    case CUSTODY_ON_FLOOR:
      return 'on_machine'
    default:
      return 'other'
  }
}

const LEDGER_BADGE: Record<ToolingLedgerZoneKey, string> = {
  incoming_triage: 'border-amber-600/70 bg-amber-950/60 text-amber-100',
  outside_vendor: 'border-violet-500/70 bg-violet-950/50 text-violet-100',
  engraving_queue: 'border-amber-500/60 bg-amber-950/40 text-amber-200',
  live_inventory: 'border-emerald-600/70 bg-emerald-950/40 text-emerald-100',
  custody_floor: 'border-orange-500/70 bg-orange-950/40 text-orange-100',
  on_machine: 'border-sky-500/70 bg-sky-950/50 text-sky-100',
  other: 'border-zinc-600 bg-zinc-900 text-zinc-300',
}

export function toolingLedgerZoneBadge(zoneKey: ToolingLedgerZoneKey): string {
  return LEDGER_BADGE[zoneKey] ?? LEDGER_BADGE.other
}

export function toolingLedgerZoneLabel(
  tool: 'dies' | 'blocks',
  zoneKey: ToolingLedgerZoneKey,
): string {
  if (tool === 'dies') {
    switch (zoneKey) {
      case 'incoming_triage':
        return DIE_HUB_ZONE.INCOMING_TRIAGE
      case 'outside_vendor':
        return DIE_HUB_ZONE.OUTSIDE_VENDOR
      case 'live_inventory':
        return DIE_HUB_ZONE.LIVE_INVENTORY
      case 'custody_floor':
        return DIE_HUB_ZONE.CUSTODY_FLOOR
      case 'on_machine':
        return DIE_HUB_ZONE.ON_MACHINE_FLOOR
      default:
        return DIE_HUB_ZONE.OTHER
    }
  }
  switch (zoneKey) {
    case 'incoming_triage':
      return EMBOSS_HUB_ZONE.INCOMING_TRIAGE
    case 'engraving_queue':
      return EMBOSS_HUB_ZONE.IN_HOUSE_ENGRAVING
    case 'live_inventory':
      return EMBOSS_HUB_ZONE.LIVE_INVENTORY
    case 'custody_floor':
      return EMBOSS_HUB_ZONE.CUSTODY_FLOOR
    case 'on_machine':
      return DIE_HUB_ZONE.ON_MACHINE_FLOOR
    default:
      return EMBOSS_HUB_ZONE.OTHER
  }
}

/** Map a die hub event `from_zone` / `to_zone` string back to `custody_status`. */
export function dieHubCustodyFromEventZone(z: string | null | undefined): string | null {
  if (!z?.trim()) return null
  const t = z.trim()
  const lower = t.toLowerCase()
  const raw = [
    CUSTODY_IN_STOCK,
    CUSTODY_AT_VENDOR,
    CUSTODY_HUB_TRIAGE,
    CUSTODY_PREPARING_FOR_PRODUCTION,
    CUSTODY_HUB_CUSTODY_READY,
    CUSTODY_ON_FLOOR,
  ]
  if (raw.includes(t)) return t
  if (lower === CUSTODY_HUB_TRIAGE) return CUSTODY_HUB_TRIAGE
  switch (t) {
    case DIE_HUB_ZONE.INCOMING_TRIAGE:
    case 'Incoming triage':
      return CUSTODY_HUB_TRIAGE
    case DIE_HUB_ZONE.OUTSIDE_VENDOR:
      return CUSTODY_AT_VENDOR
    case DIE_HUB_ZONE.LIVE_INVENTORY:
      return CUSTODY_IN_STOCK
    case DIE_HUB_ZONE.CUSTODY_FLOOR:
      return CUSTODY_HUB_CUSTODY_READY
    case DIE_HUB_ZONE.ON_MACHINE_FLOOR:
    case 'On Floor':
      return CUSTODY_ON_FLOOR
    case 'Preparing for Production':
      return CUSTODY_PREPARING_FOR_PRODUCTION
    default:
      return null
  }
}

export function embossHubCustodyFromEventZone(z: string | null | undefined): string | null {
  if (!z?.trim()) return null
  const t = z.trim()
  const raw = [
    CUSTODY_IN_STOCK,
    CUSTODY_HUB_TRIAGE,
    CUSTODY_PREPARING_FOR_PRODUCTION,
    CUSTODY_HUB_CUSTODY_READY,
    CUSTODY_HUB_ENGRAVING_QUEUE,
    CUSTODY_ON_FLOOR,
  ]
  if (raw.includes(t)) return t
  switch (t) {
    case EMBOSS_HUB_ZONE.INCOMING_TRIAGE:
    case 'Incoming triage':
      return CUSTODY_HUB_TRIAGE
    case EMBOSS_HUB_ZONE.IN_HOUSE_ENGRAVING:
      return CUSTODY_HUB_ENGRAVING_QUEUE
    case EMBOSS_HUB_ZONE.LIVE_INVENTORY:
      return CUSTODY_IN_STOCK
    case EMBOSS_HUB_ZONE.CUSTODY_FLOOR:
      return CUSTODY_HUB_CUSTODY_READY
    case DIE_HUB_ZONE.ON_MACHINE_FLOOR:
      return CUSTODY_ON_FLOOR
    case 'Preparing for Production':
      return CUSTODY_PREPARING_FOR_PRODUCTION
    default:
      return null
  }
}
