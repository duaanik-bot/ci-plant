'use client'

import type { ReactNode } from 'react'

export function BulkActionBar({
  selectedCount,
  left,
  right,
  className = '',
}: {
  selectedCount: number
  left?: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={`sticky bottom-2 z-20 rounded-lg border border-ds-line/40 bg-background/92 px-2.5 py-2 shadow-sm backdrop-blur ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {left}
        <span className="ml-auto rounded-md border border-ds-line/40 bg-ds-main/50 px-2 py-1 text-[11px]">
          Selected: {selectedCount}
        </span>
        {right}
      </div>
    </div>
  )
}
