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
    <div className={`flex flex-wrap items-center gap-1.5 py-1 ${className}`}>
      {left}
      {onSelectedClick ? (
        <button
          type="button"
          onClick={onSelectedClick}
          disabled={selectedCount === 0}
          className={[
            'ml-auto rounded-ds-sm px-2.5 py-1 text-xs font-medium transition-colors duration-150',
            selectedCount === 0
              ? 'cursor-not-allowed text-[var(--text-muted)]'
              : selectedActive
                ? 'bg-[var(--brand-bg-soft)] text-[var(--brand-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]',
          ].join(' ')}
          title={selectedActive ? 'Show all rows' : 'Show only selected rows'}
        >
          Selected: {selectedCount}
        </button>
      ) : (
        <span className="ml-auto px-2.5 py-1 text-xs text-[var(--text-secondary)]">
          Selected: {selectedCount}
        </span>
      )}
      {right}
    </div>
  )
}
