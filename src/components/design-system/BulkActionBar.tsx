'use client'

import type { ReactNode } from 'react'

export function BulkActionBar({
  selectedCount,
  left,
  right,
  className = '',
  onSelectedClick,
  selectedActive = false,
}: {
  selectedCount: number
  left?: ReactNode
  right?: ReactNode
  className?: string
  onSelectedClick?: () => void
  selectedActive?: boolean
}) {
  return (
    <div className={`sticky bottom-2 z-20 rounded-lg border border-ds-line/40 bg-background/92 px-2.5 py-2 shadow-sm backdrop-blur ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {left}
        {onSelectedClick ? (
          <button
            type="button"
            onClick={onSelectedClick}
            disabled={selectedCount === 0}
            className={`ml-auto rounded-md border px-2 py-1 text-xs transition ${
              selectedCount === 0
                ? 'cursor-not-allowed border-ds-line/30 bg-ds-main/30 text-ds-ink-faint'
                : selectedActive
                  ? 'border-ds-brand/60 bg-ds-brand/15 text-ds-ink'
                  : 'border-ds-line/40 bg-ds-main/50 text-ds-ink hover:border-ds-brand/45 hover:text-ds-brand'
            }`}
            title={selectedActive ? 'Show all rows' : 'Show only selected rows'}
          >
            Selected: {selectedCount}
          </button>
        ) : (
          <span className="ml-auto rounded-md border border-ds-line/40 bg-ds-main/50 px-2 py-1 text-xs">
            Selected: {selectedCount}
          </span>
        )}
        {right}
      </div>
    </div>
  )
}
