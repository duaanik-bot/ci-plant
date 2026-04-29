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

function toneClass(tone: Tone, active: boolean): string {
  if (!active) return 'border-ds-line/50 text-ds-ink-muted'
  switch (tone) {
    case 'brand':
      return 'border-ds-brand/40 bg-ds-brand/10 text-ds-brand'
    case 'success':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'info':
      return 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    case 'warning':
      return 'border-ds-warning/40 bg-ds-warning/10 text-ds-warning'
    case 'danger':
      return 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300'
    default:
      return 'border-ds-line/50 bg-ds-main/50 text-ds-ink'
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
    <div className={`flex flex-wrap items-center gap-2 rounded-lg border border-ds-line/40 bg-ds-elevated/20 px-2.5 py-2 ${className}`}>
      {chips.map((chip) => {
        const active = chip.active === true
        const tone = chip.tone ?? 'neutral'
        return (
          <button
            key={chip.key}
            type="button"
            onClick={chip.onClick}
            className={`rounded border px-2 py-0.5 text-xs transition-colors ${toneClass(tone, active)}`}
          >
            {chip.label} ({chip.count})
          </button>
        )
      })}
    </div>
  )
}
