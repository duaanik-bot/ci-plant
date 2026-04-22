import type { ReactNode } from 'react'

export function IndustrialKpiTile({
  label,
  value,
  hint,
  valueClassName = 'text-ds-ink',
  shellClassName = '',
  onClick,
  isActive = false,
}: {
  label: string
  value: ReactNode
  hint?: string
  valueClassName?: string
  /** Extra classes on the glass card (e.g. ring, gradient). */
  shellClassName?: string
  onClick?: () => void
  isActive?: boolean
}) {
  const interactive =
    onClick != null
      ? 'cursor-pointer text-left w-full transition hover:bg-ds-card/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ds-warning/35'
      : ''
  const active = isActive ? 'ring-2 ring-ds-warning/40' : ''
  const cls = `rounded-xl border border-border/10 bg-ds-main/35 px-3 py-2 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)] ${shellClassName} ${interactive} ${active}`

  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
        <div className={`mt-0.5 text-xl md:text-2xl font-semibold tabular-nums ${valueClassName}`}>
          {value}
        </div>
        {hint ? <div className="text-[10px] text-ds-ink-faint mt-0.5">{hint}</div> : null}
      </button>
    )
  }

  return (
    <div className={cls}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className={`mt-0.5 text-xl md:text-2xl font-semibold tabular-nums ${valueClassName}`}>
        {value}
      </div>
      {hint ? <div className="text-[10px] text-ds-ink-faint mt-0.5">{hint}</div> : null}
    </div>
  )
}
