'use client'

type Tone = 'neutral' | 'brand' | 'success' | 'info' | 'warning' | 'danger'

export type LaneCounterChip = {
  key: string
  label: string
  count: number
  active?: boolean
  onClick?: () => void
  tone?: Tone
}

function activeToneColor(tone: Tone): string {
  switch (tone) {
    case 'brand':    return 'text-[var(--brand-primary)]'
    case 'success':  return 'text-[var(--success)]'
    case 'info':     return 'text-[var(--info)]'
    case 'warning':  return 'text-[var(--warning)]'
    case 'danger':   return 'text-[var(--error)]'
    default:         return 'text-[var(--brand-primary)]'
  }
}

export function LaneCounterChips({
  chips,
  className = '',
}: {
  chips: LaneCounterChip[]
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-center gap-0 ${className}`}>
      {chips.map((chip) => {
        const active = chip.active === true
        const tone = chip.tone ?? 'neutral'
        return (
          <button
            key={chip.key}
            type="button"
            onClick={chip.onClick}
            className={[
              'relative px-3 py-2 text-sm font-medium transition-colors duration-150',
              active
                ? `${activeToneColor(tone)} after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:rounded-full after:bg-current`
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            ].join(' ')}
          >
            {chip.label} ({chip.count})
          </button>
        )
      })}
    </div>
  )
}
