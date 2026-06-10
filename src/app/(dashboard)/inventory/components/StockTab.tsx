'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/cn'
import { formatIndianInteger, joinLabelParts } from '@/lib/display-formatters'
import type { PaperWarehouseRow, WarehouseSortKey } from '../page'

const PROCUREMENT_MOVED_MESSAGE =
  'Procurement workflow moved to new Procurement module. New PR/PO/GRN flow will be enabled in next phase.'

type Props = {
  rows: PaperWarehouseRow[]
  selectedIds?: Set<string>
  sort?: { key: WarehouseSortKey; dir: 'asc' | 'desc' } | null
  allRowsSelected?: boolean
  onSort?: (key: WarehouseSortKey) => void
  onToggleAll?: (checked: boolean) => void
  onToggleSelect?: (row: PaperWarehouseRow) => void
  onRowClick: (row: PaperWarehouseRow) => void
  onOpenMaterial?: (row: PaperWarehouseRow, view: 'history' | 'reserved' | 'available' | 'shortage' | 'free') => void
  onOpenReservations?: (row: PaperWarehouseRow) => void
  onAddStock?: (row: PaperWarehouseRow) => void
  onRemoveStock?: (row: PaperWarehouseRow) => void
  onDeleteRow?: (row: PaperWarehouseRow) => void
}

export function StockTab({
  rows,
  selectedIds,
  sort,
  allRowsSelected,
  onSort,
  onToggleAll,
  onToggleSelect,
  onRowClick,
  onOpenMaterial,
  onOpenReservations,
  onAddStock,
  onRemoveStock,
  onDeleteRow,
}: Props) {
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null)
  const SortHeader = ({
    label,
    keyName,
    align = 'left',
    className,
  }: {
    label: string
    keyName: WarehouseSortKey
    align?: 'left' | 'right'
    className?: string
  }) => {
    const active = sort?.key === keyName
    const icon = active ? (sort?.dir === 'asc' ? '▲' : '▼') : '↕'
    return (
      <th className={cn('pb-2 pr-4', align === 'right' && 'text-right', className)}>
        <button
          type="button"
          onClick={() => onSort?.(keyName)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded px-1 py-0.5 uppercase tracking-wider transition hover:bg-ds-elevated/50 hover:text-ds-ink',
            align === 'right' && 'justify-end',
            active ? 'text-ds-ink' : 'text-ds-ink-faint',
          )}
          title={`Sort by ${label}`}
        >
          <span>{label}</span>
          <span className="text-[10px] leading-none opacity-70">{icon}</span>
        </button>
      </th>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
            <th className="w-1 pb-2" />
            <th className="w-8 pb-2">
              <input
                type="checkbox"
                checked={!!allRowsSelected}
                onChange={(e) => onToggleAll?.(e.target.checked)}
                className="h-3.5 w-3.5"
              />
            </th>
            <SortHeader label="Material" keyName="material_code" />
            <SortHeader label="Board / GSM" keyName="board_type_id" />
            <SortHeader label="Size" keyName="size_display" />
            <SortHeader label="Available" keyName="available_sheets" align="right" />
            <SortHeader label="Reserved" keyName="reserved_sheets" align="right" />
            <SortHeader label="Free" keyName="free" align="right" />
            <SortHeader label="Incoming" keyName="incoming_sheets" align="right" />
            <SortHeader label="Shortage" keyName="shortage_sheets" align="right" />
            <SortHeader label="DoC" keyName="daysOfCover" align="right" />
            <SortHeader label="Status" keyName="status" className="pr-2" />
            <th className="pb-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const free = Number(row.available_sheets)
            const statusTone =
              Number(row.shortage_sheets) > 0
                ? 'border-l-2 border-[var(--error)]'
                : free <= Number(row.reorder_level)
                  ? 'border-l-2 border-ds-warning'
                  : ''
            const dotClass =
              Number(row.shortage_sheets) > 0
                ? 'bg-[var(--error)]'
                : free <= Number(row.reorder_level)
                  ? 'bg-ds-warning'
                  : 'bg-[var(--success)]'
            return (
              <tr
                key={row.material_id}
                onClick={() => onRowClick(row)}
                className={cn(
                  'cursor-pointer hover:bg-ds-elevated/40',
                  statusTone,
                )}
              >
                <td className="py-2" />
                <td className="py-2 pr-2">
                  <input
                    type="checkbox"
                    checked={selectedIds?.has(row.material_id) ?? false}
                    onChange={() => onToggleSelect?.(row)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-3.5 w-3.5"
                  />
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-ds-ink">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenMaterial?.(row, 'history')
                    }}
                    className="font-semibold hover:underline hover:underline-offset-2"
                  >
                    {row.material_code}
                  </button>
                </td>
                <td className="py-2 pr-4 text-ds-ink-muted">{joinLabelParts([row.board_type_id, row.gsm ? `${row.gsm}g` : null], ' ')}</td>
                <td className="py-2 pr-4 tabular-nums text-ds-ink-muted">{row.size_display}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenMaterial?.(row, 'available')
                    }}
                    className="font-medium hover:underline hover:underline-offset-2"
                  >
                    {formatIndianInteger(row.available_sheets)}
                  </button>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">
                  {Number(row.reserved_sheets) > 0 ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenReservations?.(row)
                      }}
                      className="font-medium text-ds-warning hover:underline hover:underline-offset-2"
                    >
                      {formatIndianInteger(row.reserved_sheets)}
                    </button>
                  ) : (
                    formatIndianInteger(row.reserved_sheets)
                  )}
                </td>
                <td className={cn('py-2 pr-4 text-right tabular-nums font-medium', free < 0 ? 'text-ds-error' : free === 0 ? 'text-ds-warning' : 'text-ds-ink')}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenMaterial?.(row, 'free')
                    }}
                    className="hover:underline hover:underline-offset-2"
                  >
                    {formatIndianInteger(free)}
                  </button>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">{formatIndianInteger(row.incoming_sheets)}</td>
                <td className={cn('py-2 pr-4 text-right tabular-nums font-medium', Number(row.shortage_sheets) > 0 ? 'text-ds-error' : 'text-ds-ink-muted')}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenMaterial?.(row, 'shortage')
                    }}
                    className="hover:underline hover:underline-offset-2"
                  >
                    {formatIndianInteger(row.shortage_sheets)}
                  </button>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">
                  {row.daysOfCover != null ? `${row.daysOfCover}d` : '—'}
                </td>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', dotClass)} />
                    <span className="text-[11px] font-medium text-ds-ink-muted">{row.status}</span>
                  </div>
                </td>
                <td className="py-2 text-xs" onClick={(e) => e.stopPropagation()}>
                  <div className="relative flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onAddStock?.(row)}
                      className="rounded bg-[var(--success-bg)] px-2 py-1 font-medium text-[var(--success)] hover:opacity-90"
                    >
                      Add
                    </button>
                    <Link
                      href={`/procurement/pr/new?source=Warehouse&materialId=${encodeURIComponent(row.material_id)}&qty=${encodeURIComponent(String(Math.max(1, Number(row.shortage_sheets) || Number(row.reorder_level) || 1)))}`}
                      className="rounded bg-ds-elevated/60 px-2 py-1 font-medium text-ds-ink-muted hover:bg-[var(--brand-bg-soft)] hover:text-[var(--brand-primary)]"
                      title={PROCUREMENT_MOVED_MESSAGE}
                    >
                      Raise PR
                    </Link>
                    <button
                      type="button"
                      onClick={() => setOpenActionMenuId((prev) => (prev === row.material_id ? null : row.material_id))}
                      className="rounded bg-ds-elevated/60 px-2 py-1 font-medium text-ds-ink-muted hover:text-ds-ink"
                    >
                      More
                    </button>
                    {openActionMenuId === row.material_id ? (
                      <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-ds-md bg-background p-1 shadow-ds-depth-md">
                        <button type="button" onClick={() => { setOpenActionMenuId(null); onRemoveStock?.(row) }} className="block w-full rounded px-2 py-1 text-left hover:bg-ds-elevated/40">Remove stock</button>
                        <button type="button" onClick={() => { setOpenActionMenuId(null); onOpenMaterial?.(row, 'available') }} className="block w-full rounded px-2 py-1 text-left hover:bg-ds-elevated/40">Reserve stock</button>
                        <button type="button" onClick={() => { setOpenActionMenuId(null); onOpenReservations?.(row) }} className="block w-full rounded px-2 py-1 text-left hover:bg-ds-elevated/40">Unreserve stock</button>
                        <button type="button" onClick={() => { setOpenActionMenuId(null); onOpenMaterial?.(row, 'history') }} className="block w-full rounded px-2 py-1 text-left hover:bg-ds-elevated/40">View history</button>
                        <button type="button" onClick={() => { setOpenActionMenuId(null); onDeleteRow?.(row) }} className="block w-full rounded px-2 py-1 text-left text-[var(--error)] hover:bg-[var(--error-bg)]">Delete row</button>
                      </div>
                    ) : null}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
