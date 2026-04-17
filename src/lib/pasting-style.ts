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
