/**
 * StatusBadge
 * ────────────
 * A pill badge that maps a status string to a colour pair.
 * Underscores are replaced with spaces; text is capitalised via CSS.
 *
 * Built-in statuses:
 *   draft | confirmed | in_progress | partial | completed | dispatched |
 *   invoiced | paid | overdue | sent | cancelled | planned | received |
 *   active | inactive | pending | approved | rejected
 *
 * Usage:
 *   <StatusBadge status="in_progress" />
 *   <StatusBadge status={order.status} />
 */

const STATUS_MAP: Record<string, string> = {
  // Neutral / draft
  draft:       'bg-slate-100 text-slate-600',
  pending:     'bg-slate-100 text-slate-600',
  planned:     'bg-slate-100 text-slate-600',
  inactive:    'bg-slate-100 text-slate-500',
  // In-flight
  confirmed:   'bg-blue-100 text-blue-700',
  sent:        'bg-blue-100 text-blue-700',
  in_progress: 'bg-yellow-100 text-yellow-700',
  partial:     'bg-orange-100 text-orange-700',
  // Positive completions
  completed:   'bg-green-100 text-green-700',
  dispatched:  'bg-teal-100 text-teal-700',
  received:    'bg-green-100 text-green-700',
  paid:        'bg-green-100 text-green-700',
  active:      'bg-green-100 text-green-700',
  approved:    'bg-green-100 text-green-700',
  // Finance
  invoiced:    'bg-purple-100 text-purple-700',
  overdue:     'bg-red-100 text-red-700',
  // Negative
  cancelled:   'bg-red-100 text-red-600',
  rejected:    'bg-red-100 text-red-600',
}

interface StatusBadgeProps {
  status?: string
  className?: string
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const cls = (status && STATUS_MAP[status]) ?? 'bg-slate-100 text-slate-600'
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${cls} ${className}`}
    >
      {status?.replace(/_/g, ' ') ?? '—'}
    </span>
  )
}

export default StatusBadge
