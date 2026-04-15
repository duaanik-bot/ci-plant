/** DB values for emboss_blocks / dyes / shade_cards custody_status */

export const CUSTODY_IN_STOCK = 'in_stock'
export const CUSTODY_ON_FLOOR = 'on_floor'
export const CUSTODY_AT_VENDOR = 'at_vendor'

export type CustodyStatus = typeof CUSTODY_IN_STOCK | typeof CUSTODY_ON_FLOOR | typeof CUSTODY_AT_VENDOR

export function custodyLabel(s: string): string {
  switch (s) {
    case CUSTODY_IN_STOCK:
      return 'In Stock'
    case CUSTODY_ON_FLOOR:
      return 'On Floor'
    case CUSTODY_AT_VENDOR:
      return 'At Vendor'
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
    default:
      return 'bg-slate-800 border-slate-600 text-slate-300'
  }
}
