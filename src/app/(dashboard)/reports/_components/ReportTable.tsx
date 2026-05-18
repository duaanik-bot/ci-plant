'use client'
import {
  useReactTable, getCoreRowModel, getSortedRowModel, flexRender,
  type ColumnDef as TanCol, type SortingState,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import type { ReportResult } from '@/lib/reports/types'
import { fmtCell } from '@/lib/reports/format'
import {
  enterpriseTableClass, enterpriseTheadClass, enterpriseThClass,
  enterpriseTbodyClass, enterpriseTrClass, enterpriseTdClass,
} from '@/lib/enterprise-table-styles'

export function ReportTable({ result }: { result: ReportResult }) {
  const [sorting, setSorting] = useState<SortingState>([])
  const cols = useMemo<TanCol<Record<string, unknown>>[]>(
    () => result.columns.map((c) => ({
      accessorKey: c.key,
      header: c.label,
      cell: (ctx) => fmtCell(ctx.getValue(), c.type),
      meta: { align: c.align ?? (c.type === 'text' ? 'left' : 'right') },
    })),
    [result.columns]
  )
  const table = useReactTable({
    data: result.rows, columns: cols, state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
  })
  const totals = result.columns.filter((c) => c.total)
  return (
    <div className="overflow-auto">
      <table className={enterpriseTableClass}>
        <thead className={enterpriseTheadClass}>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} className={`${enterpriseThClass} cursor-pointer`}
                    onClick={h.column.getToggleSortingHandler()}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className={enterpriseTbodyClass}>
          {table.getRowModel().rows.map((r) => (
            <tr key={r.id} className={enterpriseTrClass}>
              {r.getVisibleCells().map((cell) => (
                <td key={cell.id}
                    className={`${enterpriseTdClass} ${(cell.column.columnDef.meta as any)?.align === 'right' ? 'text-right' : ''}`}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totals.length > 0 && (
          <tfoot>
            <tr className="font-semibold border-t border-ds-border">
              {result.columns.map((c) => (
                <td key={c.key} className={`${enterpriseTdClass} text-right`}>
                  {c.total
                    ? fmtCell(result.rows.reduce((s, row) => s + (Number(row[c.key]) || 0), 0), c.type)
                    : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
