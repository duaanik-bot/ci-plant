import { Badge } from '@/components/design-system/Badge'

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-')
}

const toneByStatus: Record<string, Parameters<typeof Badge>[0]['tone']> = {
  pending: 'neutral',
  draft: 'neutral',
  ready: 'success',
  completed: 'success',
  complete: 'success',
  released: 'success',
  partial: 'warning',
  'make-ready': 'warning',
  shortage: 'danger',
  blocked: 'danger',
  hold: 'warning',
  rework: 'danger',
  rejected: 'danger',
  reserved: 'info',
  running: 'info',
  'in-progress': 'info',
  ordered: 'tooling',
  received: 'success',
  leftover: 'neutral',
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const key = normalize(status)
  const tone = toneByStatus[key] ?? 'neutral'
  return <Badge tone={tone} className={className}>{status}</Badge>
}
