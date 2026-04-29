'use client'

import type { PastingStyle } from '@prisma/client'
import { pastingStyleLabel } from '@/lib/pasting-style'

export function PastingStyleBadge({
  value,
  className = '',
}: {
  value: PastingStyle | null | undefined
  className?: string
}) {
  if (!value) {
    return <span className={`text-neutral-600 ${className}`}>—</span>
  }
  const tone =
    value === 'LOCK_BOTTOM'
      ? 'border-sky-500/80 bg-sky-950/70 text-sky-100 shadow-[0_0_12px_rgba(56,189,248,0.12)]'
      : value === 'BSO'
        ? 'border-violet-500/80 bg-violet-950/70 text-violet-100 shadow-[0_0_12px_rgba(167,139,250,0.12)]'
        : 'border-ds-warning/75 bg-ds-warning/10 text-ds-ink'
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide ${tone} ${className}`}
    >
      {pastingStyleLabel(value)}
    </span>
  )
}
