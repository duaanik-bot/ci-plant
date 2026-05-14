import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'

const toneRing: Record<Tone, string> = {
  neutral: 'border-[var(--border)] text-[var(--text-secondary)]',
  brand: 'border-[var(--brand-primary)]/25 text-[var(--brand-primary)]',
  success: 'border-[var(--success)]/25 text-[var(--success)]',
  warning: 'border-[var(--warning)]/25 text-[var(--warning)]',
  danger: 'border-[var(--error)]/25 text-[var(--error)]',
  info: 'border-[var(--info)]/25 text-[var(--info)]',
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
    'flex items-center gap-3 rounded-ds-md border bg-[var(--bg-card)] px-4 py-3 shadow-ds-depth-sm transition-[border-color,box-shadow] duration-150 ease-out'
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
        className={cn(base, interactive, active, toneRing[tone], className)}
      >
        {inner}
      </button>
    )
  }
  return <div className={cn(base, active, toneRing[tone], className)}>{inner}</div>
}
