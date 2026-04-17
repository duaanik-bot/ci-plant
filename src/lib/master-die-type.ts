import type { PastingStyle } from '@prisma/client'
import { pastingStyleLabel } from '@/lib/pasting-style'

/** Human-facing die / pasting label from Die Master (prefers canonical `pastingStyle` when set). */
export function masterDieTypeLabel(d: {
  dyeType: string
  pastingStyle?: PastingStyle | null
}): string {
  if (d.pastingStyle != null) {
    const pl = pastingStyleLabel(d.pastingStyle)
    if (pl !== '—') return pl
  }
  return d.dyeType?.trim() || '—'
}

export function normalizeDieTypeKey(s: string | null | undefined): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}
