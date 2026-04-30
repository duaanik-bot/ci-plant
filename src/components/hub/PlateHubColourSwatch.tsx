'use client'

import {
  hubChannelRowsFromLabels,
  plateColourCanonicalKey,
  plateHubSwatchKind,
  stripPlateColourDisplaySuffix,
  type PlateHubSwatchKind,
} from '@/lib/hub-plate-card-ui'
import { pantoneContrastFg, pantoneHexApprox } from '@/lib/pantone-hex-approx'

const ACTIVE_CLASSES: Record<PlateHubSwatchKind, string> = {
  cyan: 'bg-cyan-500 text-primary-foreground',
  magenta: 'bg-plateMagenta text-foreground',
  yellow: 'bg-yellow-400 text-gray-900',
  black: 'bg-background text-foreground border border-ds-line/50',
  spotOrange: 'bg-[var(--brand-primary)] text-white',
  spotPurple: 'bg-purple-600 text-foreground',
  other: 'bg-[var(--brand-primary)] text-white',
}

const SIZE_CLASSES = {
  md: 'w-6 h-6 text-xs',
  sm: 'w-5 h-5 text-xs',
} as const

export function PlateHubColourSwatch({
  short,
  label,
  ghost = false,
  size = 'md',
  className = '',
}: {
  short: string
  label: string
  ghost?: boolean
  size?: keyof typeof SIZE_CLASSES
  className?: string
}) {
  const display = short.length > 3 ? short.slice(0, 3) : short
  const dim = SIZE_CLASSES[size]
  const base = `${dim} rounded-sm font-bold text-center flex items-center justify-center p-1 uppercase shrink-0 leading-none`

  if (ghost) {
    return (
      <div
        title={label}
        className={`${base} bg-gray-700/30 text-foreground border border-ds-line/50 ${className}`}
      >
        {display}
      </div>
    )
  }

  /** Same lookup as designing / plate requirement inputs — approximate coated hex only. */
  const cleanLabel = stripPlateColourDisplaySuffix(label).trim()
  const pantoneHex = pantoneHexApprox(cleanLabel)
  if (pantoneHex) {
    return (
      <div
        title={label}
        className={`${base} ${className}`}
        style={{
          backgroundColor: pantoneHex,
          color: pantoneContrastFg(pantoneHex),
          border: '1px solid rgba(255,255,255,0.35)',
        }}
      >
        {display}
      </div>
    )
  }

  const kind = plateHubSwatchKind(short, label)
  return (
    <div title={label} className={`${base} ${ACTIVE_CLASSES[kind]} ${className}`}>
      {display}
    </div>
  )
}

/** Wrapped row of swatches; optional `ghostCanonKeys` greys out excluded channels (partial fulfillment). */
export function PlateHubColourSwatchStrip({
  labels,
  ghostCanonKeys,
  size = 'md',
  className = '',
}: {
  labels: string[]
  ghostCanonKeys?: Set<string> | null
  size?: keyof typeof SIZE_CLASSES
  className?: string
}) {
  const rows = hubChannelRowsFromLabels(labels)
  if (!rows.length) {
    return <span className="text-xs text-neutral-500">—</span>
  }
  return (
    <div
      className={`flex flex-wrap items-center gap-1 content-center min-h-0 ${className}`}
      title={labels.join(' · ')}
    >
      {rows.map(({ key, short, label }) => {
        const canon = plateColourCanonicalKey(stripPlateColourDisplaySuffix(label))
        const ghost = Boolean(ghostCanonKeys?.size && ghostCanonKeys.has(canon))
        return (
          <PlateHubColourSwatch key={key} short={short} label={label} ghost={ghost} size={size} />
        )
      })}
    </div>
  )
}
