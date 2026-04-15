import { format, formatDistanceToNow } from 'date-fns'

/** CTP / vendor queue aging — warn after this many ms. */
export const HUB_QUEUE_STALE_MS = 24 * 60 * 60 * 1000

export function hubQueueAgeLabel(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return formatDistanceToNow(d, { addSuffix: false })
}

export function hubQueueStale(iso: string | null | undefined): boolean {
  if (!iso) return false
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  return Date.now() - d.getTime() > HUB_QUEUE_STALE_MS
}

export function hubAddedToRackLabel(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return format(d, 'MMM d, yyyy h:mm a')
}

export function hubMarkedReadyLabel(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return formatDistanceToNow(d, { addSuffix: true })
}
