import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'

/** Icon color per tone — no border, just tinted icon */
const toneIcon: Record<Tone, string> = {
  neutral: 'text-[var(--text-secondary)]',
  brand: 'text-[var(--brand-primary)]',
  success: 'text-[var(--success)]',
  warning: 'text-[var(--warning)]',
  danger: 'text-[var(--error)]',
  info: 'text-[var(--info)]',
}

export type KpiTileProps = {
  label: string
  value: ReactNode
  tone?: Tone
  icon?: ReactNode
  hint?: ReactNode
  /** When provided, renders as button + adds focus ring */
  onClick?: () => void
  isActive?: boolean
  /** Smaller value typography for currency / long strings */
  raw?: boolean
  className?: string
}

export function KpiTile({
  label,
  value,
  tone = 'neutral',
  icon,
  hint,
  onClick,
  isActive,
  raw,
  className,
}: KpiTileProps) {
  const base =
    'flex items-center gap-3 rounded-ds-md bg-[var(--bg-card)] px-4 py-3 shadow-ds-depth transition-shadow duration-150 ease-out'
  const interactive = onClick
    ? 'cursor-pointer text-left hover:shadow-ds-depth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]/30'
    : ''
  const active = isActive ? 'ring-2 ring-[var(--brand-primary)]/35' : ''

  const inner = (
    <>
      {icon ? <span className="opacity-70 [&>svg]:h-4 [&>svg]:w-4">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'font-semibold tabular-nums text-[var(--text-primary)]',
            raw ? 'text-base md:text-lg' : 'text-2xl leading-tight',
          )}
        >
          {value}
        </div>
        <div className="mt-0.5 truncate text-[11px] uppercase tracking-wider text-[var(--text-secondary)]">
          {label}
        </div>
        {hint ? (
          <div className="mt-0.5 truncate text-[11px] text-[var(--text-tertiary,var(--text-secondary))]">
            {hint}
          </div>
        ) : null}
      </div>
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(base, interactive, active, toneIcon[tone], className)}
      >
        {inner}
      </button>
    )
  }
  return <div className={cn(base, active, toneIcon[tone], className)}>{inner}</div>
}
