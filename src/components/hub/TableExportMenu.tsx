'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildExportMatrix,
  downloadLedgerPdf,
  downloadLedgerXlsx,
} from '@/lib/table-export-download'

export type TableExportColumn<T> = { header: string; getValue: (row: T) => string }

type TableExportMenuProps<T> = {
  rows: T[]
  columns: TableExportColumn<T>[]
  /** Appended after `columns` for Excel only (e.g. lead time). Omitted from PDF. */
  excelOnlyColumns?: TableExportColumn<T>[]
  fileBase: string
  reportTitle: string
  sheetName?: string
  filterSummary?: string[]
  className?: string
  buttonClassName?: string
  menuClassName?: string
  disabled?: boolean
}

export function TableExportMenu<T>({
  rows,
  columns,
  excelOnlyColumns,
  fileBase,
  reportTitle,
  sheetName = 'Export',
  filterSummary,
  className = '',
  buttonClassName = '',
  menuClassName = '',
  disabled = false,
}: TableExportMenuProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const runExport = useCallback(
    (kind: 'xlsx' | 'pdf') => {
      const cols =
        kind === 'xlsx' && excelOnlyColumns?.length
          ? [...columns, ...excelOnlyColumns]
          : columns
      const matrix = buildExportMatrix(cols, rows)
      if (kind === 'xlsx') {
        downloadLedgerXlsx({
          fileBase,
          sheetName,
          title: reportTitle,
          filterSummary,
          matrix,
        })
      } else {
        downloadLedgerPdf({
          fileBase,
          title: reportTitle,
          filterSummary,
          matrix,
        })
      }
      setOpen(false)
    },
    [columns, excelOnlyColumns, rows, fileBase, sheetName, reportTitle, filterSummary],
  )

  const empty = rows.length === 0

  return (
    <div className={`relative ${className}`} ref={rootRef}>
      <button
        type="button"
        disabled={disabled || empty}
        onClick={() => setOpen((v) => !v)}
        title={empty ? 'No rows to export' : 'Export current table'}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-ds-line/50 bg-ds-card text-ds-ink text-xs font-semibold hover:bg-ds-elevated disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap ${buttonClassName}`}
      >
        <span aria-hidden>⬇️</span>
        Export
      </button>
      {open && !empty && (
        <div
          className={`absolute right-0 mt-1 min-w-[14rem] rounded-lg border border-ds-line/50 bg-ds-main py-1 shadow-xl z-50 ${menuClassName}`}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-2 text-sm text-ds-ink hover:bg-ds-elevated"
            onClick={() => runExport('xlsx')}
          >
            Export to Excel (.xlsx)
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-2 text-sm text-ds-ink hover:bg-ds-elevated"
            onClick={() => runExport('pdf')}
          >
            Export to PDF
          </button>
        </div>
      )}
    </div>
  )
}
