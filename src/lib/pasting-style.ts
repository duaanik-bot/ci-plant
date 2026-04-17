import { PastingStyle } from '@prisma/client'

export { PastingStyle }

/** Values allowed on Die / Product masters and hub logic. */
export const PASTING_STYLE_ORDER: readonly PastingStyle[] = [
  PastingStyle.LOCK_BOTTOM,
  PastingStyle.BSO,
  PastingStyle.SPECIAL,
] as const

/** Manual PO / hub vendor entry: facility primary standards only (no SPECIAL). */
export const PO_MANUAL_PASTING_VALUES: readonly PastingStyle[] = [
  PastingStyle.LOCK_BOTTOM,
  PastingStyle.BSO,
] as const

/** Lock Bottom / BSO only — PO one-click master sync and manual cells. */
export type PoManualPastingStyle = (typeof PO_MANUAL_PASTING_VALUES)[number]

/** Die Hub “add die” manual vendor form — same as PO manual. */
export const DIE_HUB_PASTING_TYPES = PO_MANUAL_PASTING_VALUES

export function pastingStyleLabel(s: PastingStyle | null | undefined): string {
  if (!s) return '—'
  switch (s) {
    case PastingStyle.LOCK_BOTTOM:
      return 'Lock Bottom'
    case PastingStyle.BSO:
      return 'BSO'
    case PastingStyle.SPECIAL:
      return 'Special'
    default:
      return String(s)
  }
}

/** Short label for tight UI (badges). */
export function pastingStyleShortLabel(s: PastingStyle | null | undefined): string {
  if (!s) return '—'
  if (s === PastingStyle.LOCK_BOTTOM) return 'LB'
  if (s === PastingStyle.BSO) return 'BSO'
  return 'Spec'
}

/**
 * Map legacy free-text pasting / carton construct strings to the new enum.
 * Unknown non-empty values → SPECIAL (queue for master review).
 */
export function mapLegacyPastingToEnum(raw: string | null | undefined): PastingStyle | null {
  const t = (raw ?? '').trim().toLowerCase()
  if (!t) return null
  if (
    t.includes('lock') &&
    (t.includes('bottom') || t.includes('lock bottom') || t.includes('crash'))
  ) {
    return PastingStyle.LOCK_BOTTOM
  }
  if (t === 'bso' || t.startsWith('bso')) {
    return PastingStyle.BSO
  }
  return PastingStyle.SPECIAL
}

/** Normalize PO spec / API string (human or enum literal) to PastingStyle. */
export function coercePastingStyleInput(raw: unknown): PastingStyle | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  const u = t.toUpperCase().replace(/\s+/g, '_')
  if (u === 'LOCK_BOTTOM' || u === 'LOCK-BOTTOM') return PastingStyle.LOCK_BOTTOM
  if (u === 'BSO') return PastingStyle.BSO
  if (u === 'SPECIAL') return PastingStyle.SPECIAL
  return mapLegacyPastingToEnum(t)
}

export function pastingNeedsMasterReview(s: PastingStyle | null | undefined): boolean {
  return s == null || s === PastingStyle.SPECIAL
}

/** PO + Die Hub triage: hub cards only use Lock Bottom or BSO. */
export function normalizePoTriagePastingStyle(s: PastingStyle | null | undefined): PastingStyle {
  if (s === PastingStyle.BSO) return PastingStyle.BSO
  return PastingStyle.LOCK_BOTTOM
}

/** Command palette + compact search rows — matches PO Lock Bottom (indigo) / BSO (violet) badges. */
export function pastingStyleSearchBadgeClass(s: PastingStyle | null | undefined): string {
  if (s === PastingStyle.BSO) {
    return 'rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-violet-600/80 text-white ring-1 ring-violet-300/35'
  }
  if (s === PastingStyle.LOCK_BOTTOM) {
    return 'rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-indigo-600/80 text-white ring-1 ring-indigo-300/35'
  }
  if (s === PastingStyle.SPECIAL) {
    return 'rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-slate-600/80 text-slate-200 ring-1 ring-slate-400/30'
  }
  return 'rounded px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 ring-1 ring-slate-600/60'
}
