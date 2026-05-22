import { cn } from '@/lib/cn'
import type { ElementType } from 'react'

/**
 * KpiCard
 * ────────
 * A metric tile for dashboards. Shows an icon, title, large value, and a
 * subtle sub-line. Supports 5 colour themes. Loading state shows a shimmer.
 *
 * Color themes:  blue | green | orange | red | slate
 *
 * Usage:
 *   import { Users } from 'lucide-react'
 *   <KpiCard
 *     title="Active Orders"
 *     value="1,284"
 *     sub="↑ 12% vs last month"
 *     icon={Users}
 *     color="orange"
 *   />
 *
 * Dashboard grid (4-up):
 *   <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
 *     <KpiCard ... />
 *   </div>
 */

type KpiColor = 'blue' | 'green' | 'orange' | 'red' | 'slate'

const THEMES: Record<KpiColor, { wrap: string; icon: string; val: string }> = {
  blue:   { wrap: 'bg-blue-50',    icon: 'text-blue-600',   val: 'text-blue-700' },
  green:  { wrap: 'bg-green-50',   icon: 'text-green-600',  val: 'text-green-700' },
  orange: { wrap: 'bg-amber-50',   icon: 'text-amber-600',  val: 'text-amber-700' },
  red:    { wrap: 'bg-red-50',     icon: 'text-red-600',    val: 'text-red-700' },
  slate:  { wrap: 'bg-ds-elevated',icon: 'text-ds-ink-muted', val: 'text-ds-ink' },
}

interface KpiCardProps {
  title: string
  value?: string | number
  sub?: string
  icon: ElementType
  color?: KpiColor
  loading?: boolean
  className?: string
}

export function KpiCard({
  title,
  value,
  sub,
  icon: Icon,
  color   = 'blue',
  loading = false,
  className,
}: KpiCardProps) {
  const c = THEMES[color] ?? THEMES.blue

  return (
    <div className={cn(
      'bg-ds-card rounded-ds-md border border-ds-line p-5 flex items-start gap-4 shadow-card',
      className,
    )}>
      {/* Icon tile */}
      <div className={cn('p-2.5 rounded-ds-sm shrink-0', c.wrap)}>
        <Icon size={20} className={c.icon} />
      </div>

      {/* Content */}
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-ds-ink-muted uppercase tracking-[0.06em] leading-none">
          {title}
        </p>

        {loading ? (
          <div className="h-7 w-20 bg-ds-elevated rounded animate-pulse mt-1.5" />
        ) : (
          <p className={cn('text-2xl font-bold mt-1 leading-none tabular-nums', c.val)}>
            {value ?? '—'}
          </p>
        )}

        {sub && !loading && (
          <p className="text-xs text-ds-ink-faint mt-1 truncate">{sub}</p>
        )}
      </div>
    </div>
  )
}

export default KpiCard
