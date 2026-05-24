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
    return <span className={`text-[var(--text-secondary)] ${className}`}>—</span>
  }
  const tone =
    value === 'LOCK_BOTTOM'
      ? 'bg-[var(--brand-bg-soft)] text-[var(--brand-primary)] shadow-[0_0_12px_rgba(249,115,22,0.12)]'
      : value === 'BSO'
        ? 'bg-[var(--success-bg)] text-[var(--success)] shadow-[0_0_12px_rgba(34,197,94,0.12)]'
        : 'bg-ds-warning/10 text-ds-ink'
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide ${tone} ${className}`}
    >
      {pastingStyleLabel(value)}
    </span>
  )
}
