'use client'

import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { History } from 'lucide-react'

/** Re-render periodically so "time ago" stays accurate during long sessions. */
function useMinuteTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return tick
}

/**
 * Compact metadata line: hub priority reorder audit (hidden when never reordered).
 * JetBrains via `font-designing-queue`; muted slate, top border.
 */
export function HubPriorityReorderAuditFooter({
  lastReorderedBy,
  lastReorderedAt,
  className = '',
}: {
  lastReorderedBy?: string | null
  lastReorderedAt?: string | null
  className?: string
}) {
  const tick = useMinuteTick()
  const raw = lastReorderedAt?.trim()
  if (!raw) return null
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return null
  void tick
  const who = lastReorderedBy?.trim() || 'System'
  const label = formatDistanceToNow(at, { addSuffix: true })
  return (
    <div
      className={`border-t border-neutral-200/80 dark:border-ds-line/50 pt-1.5 mt-1.5 flex items-center gap-1.5 min-w-0 font-designing-queue text-xs leading-tight text-ds-ink-muted dark:text-ds-ink-faint ${className}`.trim()}
      title={`${who} — ${at.toLocaleString()}`}
    >
      <History
        className="h-2.5 w-2.5 shrink-0 text-ds-ink-muted dark:text-ds-ink-faint"
        strokeWidth={2}
        aria-hidden
      />
      <span className="min-w-0 break-words">
        Moved by {who} · {label}
      </span>
    </div>
  )
}
