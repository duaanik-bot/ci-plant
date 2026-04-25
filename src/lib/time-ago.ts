export function formatShortTimeAgo(isoLike: unknown): string | null {
  if (typeof isoLike !== 'string' || !isoLike) return null
  const delta = Date.now() - new Date(isoLike).getTime()
  if (!Number.isFinite(delta) || delta < 0) return null
  const mins = Math.floor(delta / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
