'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

export type SortDir = 'asc' | 'desc'
export type SortState<K extends string> = { key: K; dir: SortDir }

export function cycleSort<K extends string>(
  current: SortState<K>,
  key: K,
  firstDir: SortDir = 'asc',
): SortState<K> {
  if (current.key !== key) return { key, dir: firstDir }
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
}

export function compareTableValues(a: string | number | null | undefined, b: string | number | null | undefined): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return debounced
}

export function useSelectionSet<T extends string | number>(initial?: Iterable<T>) {
  const [selected, setSelected] = useState<Set<T>>(() => new Set(initial))

  const toggle = useCallback((id: T) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clear = useCallback(() => setSelected(new Set<T>()), [])

  const setMany = useCallback((ids: Iterable<T>, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  return { selected, setSelected, toggle, clear, setMany }
}

export function visibleSelectionState<T>(
  rows: readonly T[],
  selected: ReadonlySet<string>,
  getId: (row: T) => string,
) {
  const visibleIds = rows.map(getId)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someSelected = visibleIds.some((id) => selected.has(id))
  return { visibleIds, allSelected, someSelected }
}

export function selectedRows<T>(
  rows: readonly T[],
  selected: ReadonlySet<string>,
  getId: (row: T) => string,
): T[] {
  return rows.filter((row) => selected.has(getId(row)))
}

export function paginationMeta(input: { page: number; limit: number; total: number }) {
  const totalPages = Math.max(1, Math.ceil(input.total / input.limit))
  const page = Math.min(Math.max(1, input.page), totalPages)
  return {
    page,
    limit: input.limit,
    total: input.total,
    totalPages,
    from: input.total === 0 ? 0 : (page - 1) * input.limit + 1,
    to: Math.min(page * input.limit, input.total),
    hasPrev: page > 1,
    hasNext: page < totalPages,
  }
}

export function TableStateRow({
  colSpan,
  loading,
  emptyMessage = 'No records found.',
}: {
  colSpan: number
  loading?: boolean
  emptyMessage?: ReactNode
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-ds-ink-faint">
        {loading ? 'Loading...' : emptyMessage}
      </td>
    </tr>
  )
}

export function RowActionSlot({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={className}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

export function useDetailLoader<T>() {
  const [id, setId] = useState<string | null>(null)
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const reset = useCallback(() => {
    setId(null)
    setData(null)
    setLoading(false)
  }, [])
  return useMemo(
    () => ({ id, setId, data, setData, loading, setLoading, reset }),
    [id, data, loading, reset],
  )
}
