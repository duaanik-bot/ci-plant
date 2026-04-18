'use client'

const mono = 'font-designing-queue tabular-nums tracking-tight'

function strokeColor(healthPct: number): string {
  if (healthPct > 80) return '#10b981'
  if (healthPct >= 50) return '#f59e0b'
  return '#f87171'
}

type Props = {
  healthPct: number
  hasSchedule: boolean
  size?: 'sm' | 'md'
  onClick?: () => void
  title?: string
}

export function MachineHealthMeter({
  healthPct,
  hasSchedule,
  size = 'sm',
  onClick,
  title,
}: Props) {
  const dim = size === 'md' ? 44 : 36
  const r = size === 'md' ? 17 : 14
  const c = 2 * Math.PI * r
  const pct = hasSchedule ? Math.max(0, Math.min(100, healthPct)) : 0
  const dash = c * (1 - pct / 100)
  const stroke = hasSchedule ? strokeColor(healthPct) : '#52525b'
  const low = hasSchedule && healthPct < 50

  const inner = (
    <>
      <svg width={dim} height={dim} className="-rotate-90 shrink-0" aria-hidden>
        <circle cx={dim / 2} cy={dim / 2} r={r} fill="none" stroke="#27272a" strokeWidth="3" />
        <circle
          cx={dim / 2}
          cy={dim / 2}
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={dash}
          className="transition-[stroke-dashoffset,stroke] duration-500"
        />
      </svg>
      <span
        className={`absolute inset-0 flex items-center justify-center text-[10px] ${mono} ${
          !hasSchedule ? 'text-zinc-600' : low ? 'text-red-300' : healthPct > 80 ? 'text-emerald-400' : 'text-amber-300'
        }`}
      >
        {hasSchedule ? `${Math.round(healthPct)}` : '—'}
      </span>
    </>
  )

  const wrapCls = `relative inline-flex items-center justify-center ${low ? 'animate-pulse' : ''}`

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title ?? 'Open preventive maintenance'}
        className={`${wrapCls} rounded-full border border-transparent hover:border-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 p-0.5`}
      >
        {inner}
      </button>
    )
  }

  return (
    <span className={wrapCls} title={title}>
      {inner}
    </span>
  )
}
