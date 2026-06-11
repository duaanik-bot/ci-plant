'use client'

import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ReactNode } from 'react'

/**
 * DataTable
 * ──────────
 * A card-wrapped <table> with:
 *   • Sticky header row
 *   • Loading spinner centred in body
 *   • Empty-state message
 *   • Column-level custom render + right-align support
 *
 * Column definition:
 *   {
 *     key:        string               // row[key] for default render
 *     label:      string               // column header text
 *     align?:     'left' | 'right'     // default 'left'
 *     className?: string              // extra td classes
 *     render?:    (row: T) => ReactNode
 *   }
 *
 * Usage:
 *   const cols = [
 *     { key: 'name',   label: 'Name' },
 *     { key: 'status', label: 'Status', render: row => <StatusBadge status={row.status} /> },
 *     { key: 'amount', label: 'Amount', align: 'right',
 *       render: row => <span>₹{row.amount.toLocaleString()}</span> },
 *   ]
 *   <DataTable columns={cols} data={items} loading={isLoading} />
 */

export interface TableColumn<T = any> {
  key: string
  label: ReactNode | (() => ReactNode)
  align?: 'left' | 'right'
  className?: string
  render?: (row: T) => ReactNode
}

interface DataTableProps<T = any> {
  columns: TableColumn<T>[]
  data: T[]
  loading?: boolean
  emptyMessage?: string
  /** Optional extra classes for the table element */
  tableClassName?: string
  /** Optional per-row extra class names */
  rowClassName?: (row: T) => string
  /** Optional full-row click handler for list/detail navigation */
  onRowClick?: (row: T) => void
}

export function DataTable<T extends { id?: string | number }>({
  columns,
  data,
  loading,
  emptyMessage = 'No records found.',
  tableClassName,
  rowClassName,
  onRowClick,
}: DataTableProps<T>) {
  return (
    <div className="bg-ds-card rounded-ds-md overflow-hidden shadow-card">
      <div className="overflow-x-auto">
        <table className={cn('w-full text-sm', tableClassName)}>

          {/* ── Header ── */}
          <thead>
            <tr className="bg-ds-elevated">
              {columns.map(col => (
                <th
                  key={col.key}
                  className={cn(
                    'px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-ds-ink-muted whitespace-nowrap',
                    col.align === 'right' ? 'text-right' : 'text-left',
                    col.className,
                  )}
                >
                  {typeof col.label === 'function' ? col.label() : col.label}
                </th>
              ))}
            </tr>
          </thead>

          {/* ── Body ── */}
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="py-14 text-center">
                  <Loader2 className="animate-spin text-ds-ink-faint mx-auto" size={24} />
                </td>
              </tr>
            ) : !data?.length ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="py-12 text-center text-ds-ink-muted text-sm"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              data.map((row, i) => (
                <tr
                  key={(row as { id?: string | number }).id ?? i}
                  onClick={() => onRowClick?.(row)}
                  className={cn(
                    'hover:bg-ds-elevated/50 transition-colors',
                    onRowClick && 'cursor-pointer',
                    rowClassName?.(row),
                  )}
                >
                  {columns.map(col => (
                    <td
                      key={col.key}
                      className={cn(
                        'px-4 py-3 text-ds-ink',
                        col.align === 'right' && 'text-right',
                        col.className,
                      )}
                    >
                      {col.render
                        ? col.render(row)
                        : String((row as any)[col.key] ?? '—')
                      }
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default DataTable
