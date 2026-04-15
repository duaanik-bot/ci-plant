/** DB values for emboss_blocks / dyes / shade_cards custody_status */

export const CUSTODY_IN_STOCK = 'in_stock'
export const CUSTODY_ON_FLOOR = 'on_floor'
export const CUSTODY_AT_VENDOR = 'at_vendor'
/** Plate-style tooling hub — incoming triage column */
export const CUSTODY_HUB_TRIAGE = 'hub_triage'
/** Die / emboss marked ready on custody floor (pre-press staging) */
export const CUSTODY_HUB_CUSTODY_READY = 'hub_custody_ready'
/** Emboss hub — in-house engraving queue */
export const CUSTODY_HUB_ENGRAVING_QUEUE = 'hub_engraving_queue'

export type CustodyStatus = typeof CUSTODY_IN_STOCK | typeof CUSTODY_ON_FLOOR | typeof CUSTODY_AT_VENDOR

export function custodyLabel(s: string): string {
  switch (s) {
    case CUSTODY_IN_STOCK:
      return 'In Stock'
    case CUSTODY_ON_FLOOR:
      return 'On Floor'
    case CUSTODY_AT_VENDOR:
      return 'At Vendor'
    case CUSTODY_HUB_TRIAGE:
      return 'Hub triage'
    case CUSTODY_HUB_CUSTODY_READY:
      return 'Custody staging'
    case CUSTODY_HUB_ENGRAVING_QUEUE:
      return 'Engraving queue'
    default:
      return s || '—'
  }
}

export function custodyBadgeClass(s: string): string {
  switch (s) {
    case CUSTODY_IN_STOCK:
      return 'bg-emerald-900/60 border-emerald-600 text-emerald-200'
    case CUSTODY_ON_FLOOR:
      return 'bg-blue-900/60 border-blue-600 text-blue-200'
    case CUSTODY_AT_VENDOR:
      return 'bg-amber-900/50 border-amber-600 text-amber-200'
    case CUSTODY_HUB_TRIAGE:
      return 'bg-zinc-800 border-zinc-500 text-zinc-200'
    case CUSTODY_HUB_CUSTODY_READY:
      return 'bg-amber-950/60 border-amber-600 text-amber-200'
    case CUSTODY_HUB_ENGRAVING_QUEUE:
      return 'bg-violet-950/50 border-violet-600 text-violet-200'
    default:
      return 'bg-slate-800 border-slate-600 text-slate-300'
  }
}
