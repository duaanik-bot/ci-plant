'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/cn'
import { computeRag, ragBorderClass, ragDotClass } from '@/lib/procurement-rag'
import { computeSuggestion } from '@/lib/procurement-suggestions'
import type { PaperWarehouseRow } from '../page'

type Props = {
  rows: PaperWarehouseRow[]
  selectedIds?: Set<string>
  allRowsSelected?: boolean
  onToggleAll?: (checked: boolean) => void
  onToggleSelect?: (row: PaperWarehouseRow) => void
  onRowClick: (row: PaperWarehouseRow) => void
  onOpenMaterial?: (row: PaperWarehouseRow, view: 'history' | 'reserved' | 'available' | 'shortage' | 'free') => void
  onOpenReservations?: (row: PaperWarehouseRow) => void
  onAddStock?: (row: PaperWarehouseRow) => void
  onRemoveStock?: (row: PaperWarehouseRow) => void
  onDeleteRow?: (row: PaperWarehouseRow) => void
  onProcure?: (row: PaperWarehouseRow) => void
  onManualProcure?: (row: PaperWarehouseRow) => void
}

const nf = new Intl.NumberFormat('en-IN')

export function StockTab({
  rows,
  selectedIds,
  allRowsSelected,
  onToggleAll,
  onToggleSelect,
  onRowClick,
  onOpenMaterial,
  onOpenReservations,
  onAddStock,
  onRemoveStock,
  onDeleteRow,
  onProcure,
  onManualProcure,
}: Props) {
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null)

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
            <th className="pb-2 pr-4">Material</th>
            <th className="pb-2 pr-4">Board / GSM</th>
            <th className="pb-2 pr-4">Size</th>
            <th className="pb-2 pr-4 text-right">Available</th>
            <th className="pb-2 pr-4 text-right">Reserved</th>
            <th className="pb-2 pr-4 text-right">Free</th>
            <th className="pb-2 pr-4 text-right">Incoming</th>
            <th className="pb-2 pr-4 text-right">Shortage</th>
            <th className="pb-2 pr-4 text-right">DoC</th>
            <th className="pb-2">Status</th>
            <th className="pb-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const free = Number(row.available_sheets) - Number(row.reserved_sheets)
            const rag = computeRag({
              shortage_sheets: Number(row.shortage_sheets),
              open_pr_id: row.open_pr_id ?? null,
              open_pr_status: row.open_pr_status ?? null,
              hasOpenPo: row.hasOpenPo ?? false,
            })
            const suggestion = rag === 'red'
              ? computeSuggestion({
                  shortage_sheets: Number(row.shortage_sheets),
                  incoming_sheets: Number(row.incoming_sheets),
                  reorder_level: Number(row.reorder_level),
                  daysOfCover: row.daysOfCover,
                  packet_weight: Number(row.packet_weight),
                })
              : null

            return (
              <tr
                key={row.material_id}
                onClick={() => onRowClick(row)}
                className={cn(
                  'cursor-pointer hover:bg-ds-elevated/40',
                  ragBorderClass(rag),
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
                <td className="py-2 pr-4 text-ds-ink-muted">{[row.board_type_id, row.gsm ? `${row.gsm}g` : null].filter(Boolean).join(' ')}</td>
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
                    {nf.format(Number(row.available_sheets))}
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
                      {nf.format(Number(row.reserved_sheets))}
                    </button>
                  ) : (
                    nf.format(Number(row.reserved_sheets))
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
                    {nf.format(free)}
                  </button>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">{nf.format(Number(row.incoming_sheets))}</td>
                <td className={cn('py-2 pr-4 text-right tabular-nums font-medium', Number(row.shortage_sheets) > 0 ? 'text-ds-error' : 'text-ds-ink-muted')}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenMaterial?.(row, 'shortage')
                    }}
                    className="hover:underline hover:underline-offset-2"
                  >
                    {nf.format(Number(row.shortage_sheets))}
                  </button>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">
                  {row.daysOfCover != null ? `${row.daysOfCover}d` : '—'}
                </td>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', ragDotClass(rag))} />
                    <span className="text-[11px] font-medium text-ds-ink-muted">{row.status}</span>
                    {suggestion && (
                      <span className="text-[11px] text-[var(--brand-primary)]">
                        ~{nf.format(Math.round(suggestion.suggestedKg))} kg
                      </span>
                    )}
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
                    {row.open_pr_id ? (
                      <Link
                        href={`/inventory/purchase-requisitions?prId=${encodeURIComponent(row.open_pr_id)}`}
                        className="rounded bg-[var(--brand-bg-soft)] px-2 py-1 font-medium text-ds-brand hover:opacity-90"
                      >
                        PR
                      </Link>
                    ) : Number(row.shortage_sheets) > 0 ? (
                      <button
                        type="button"
                        onClick={() => onProcure?.(row)}
                        className="rounded bg-[var(--error-bg)] px-2 py-1 font-medium text-[var(--error)] hover:opacity-90"
                      >
                        PR
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onManualProcure?.(row)}
                        className="rounded bg-ds-elevated/60 px-2 py-1 font-medium text-ds-ink-muted hover:text-ds-ink"
                      >
                        PR
                      </button>
                    )}
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
