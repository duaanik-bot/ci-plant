'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Pagination
 * ───────────
 * "Showing X–Y of Z" text + prev/next + numbered page buttons.
 * Renders nothing if totalPages ≤ 1.
 *
 * Usage:
 *   <Pagination page={page} total={total} limit={20} onChange={setPage} />
 */
interface PaginationProps {
  page: number
  total: number
  limit: number
  onChange: (page: number) => void
}

export function Pagination({ page, total, limit, onChange }: PaginationProps) {
  const totalPages = Math.ceil(total / limit)
  if (totalPages <= 1) return null

  const from = (page - 1) * limit + 1
  const to   = Math.min(page * limit, total)

  // Show up to 5 page buttons, centred on current page
  const pageButtons = (() => {
    const count = Math.min(totalPages, 5)
    let start = Math.max(1, page - Math.floor(count / 2))
    if (start + count - 1 > totalPages) start = totalPages - count + 1
    return Array.from({ length: count }, (_, i) => start + i)
  })()

  return (
    <div className="flex items-center justify-between px-4 py-3">
      <p className="text-xs text-ds-ink-muted">
        Showing{' '}
        <span className="font-medium text-ds-ink">{from}–{to}</span>
        {' '}of{' '}
        <span className="font-medium text-ds-ink">{total}</span>
      </p>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
          className="p-1.5 rounded-ds-sm text-ds-ink-muted hover:bg-ds-elevated disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Previous page"
        >
          <ChevronLeft size={15} />
        </button>

        {pageButtons.map(p => (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={cn(
              'w-7 h-7 rounded-ds-sm text-xs font-medium transition-colors',
              p === page
                ? 'bg-ds-brand text-white'
                : 'text-ds-ink-muted hover:bg-ds-elevated',
            )}
          >
            {p}
          </button>
        ))}

        <button
          onClick={() => onChange(page + 1)}
          disabled={page === totalPages}
          className="p-1.5 rounded-ds-sm text-ds-ink-muted hover:bg-ds-elevated disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Next page"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  )
}

export default Pagination
