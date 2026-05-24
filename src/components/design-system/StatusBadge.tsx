import { Badge } from '@/components/design-system/Badge'

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-')
}

const toneByStatus: Record<string, Parameters<typeof Badge>[0]['tone']> = {
  // Workflow states
  pending: 'neutral',
  draft: 'neutral',
  planned: 'neutral',
  confirmed: 'info',
  sent: 'info',
  reserved: 'info',
  running: 'info',
  'in-progress': 'info',
  ready: 'success',
  'make-ready': 'warning',
  partial: 'warning',
  hold: 'warning',
  // Positive completions
  completed: 'success',
  complete: 'success',
  released: 'success',
  received: 'success',
  dispatched: 'info',
  paid: 'success',
  active: 'success',
  approved: 'success',
  // Finance / tooling
  invoiced: 'tooling',
  ordered: 'tooling',
  // Negative
  shortage: 'danger',
  blocked: 'danger',
  rework: 'danger',
  rejected: 'danger',
  cancelled: 'danger',
  overdue: 'danger',
  // Inactive
  inactive: 'neutral',
  leftover: 'neutral',
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const key = normalize(status)
  const tone = toneByStatus[key] ?? 'neutral'
  return <Badge tone={tone} className={className}>{status}</Badge>
}
