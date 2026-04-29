'use client'

import { CircleHelp } from 'lucide-react'

type RowStateLegendProps = {
  includeSelected?: boolean
  selectedLabel?: string
  helperText: string
}

export function RowStateLegend({
  includeSelected = false,
  selectedLabel = 'Selected',
  helperText,
}: RowStateLegendProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ds-ink-muted">
      <span className="font-semibold text-ds-ink-faint">Row states:</span>
      <span
        className="inline-flex items-center text-ds-ink-faint"
        title={helperText}
        aria-label="Row state help"
      >
        <CircleHelp className="h-3.5 w-3.5" />
      </span>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-ds-warning" /> Priority</span>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Pushed</span>
      {includeSelected ? (
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-ds-brand" /> {selectedLabel}</span>
      ) : (
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-ds-elevated ring-1 ring-ds-line/50" /> Normal</span>
      )}
    </div>
  )
}
