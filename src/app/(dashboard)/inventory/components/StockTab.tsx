'use client'

import { cn } from '@/lib/cn'
import { ChevronRight } from 'lucide-react'
import { computeRag, ragBorderClass, ragDotClass } from '@/lib/procurement-rag'
import { computeSuggestion } from '@/lib/procurement-suggestions'
import type { PaperWarehouseRow } from '../page'

type Props = {
  rows: PaperWarehouseRow[]
  onRowClick: (row: PaperWarehouseRow) => void
  selectedIds: Set<string>
  onToggleRow: (materialId: string, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
  onProcure: (row: PaperWarehouseRow) => void
  onOpenReservations: (row: PaperWarehouseRow) => void
}

const nf = new Intl.NumberFormat('en-IN')

export function StockTab({
  rows,
  onRowClick,
  selectedIds,
  onToggleRow,
  onToggleAll,
  onProcure,
  onOpenReservations,
}: Props) {
  const allRowsSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.material_id))

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
            <th className="w-8 pb-2">
              <input
                type="checkbox"
                aria-label="Select all rows"
                checked={allRowsSelected}
                onChange={(e) => onToggleAll(e.target.checked)}
                className="h-4 w-4 align-middle"
              />
            </th>
            <th className="w-1 pb-2" /> {/* RAG border column */}
            <th className="pb-2 pr-4">Material</th>
            <th className="pb-2 pr-4">Board / GSM</th>
            <th className="pb-2 pr-4">Size</th>
            <th className="pb-2 pr-4 text-right">Available</th>
            <th className="pb-2 pr-4 text-right">Reserved</th>
            <th className="pb-2 pr-4 text-right">Incoming</th>
            <th className="pb-2 pr-4 text-right">Shortage</th>
            <th className="pb-2 pr-4 text-right">DoC</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
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
            const reserved = Number(row.reserved_sheets)
            const selected = selectedIds.has(row.material_id)

            return (
              <tr
                key={row.material_id}
                onClick={() => onRowClick(row)}
                className={cn(
                  'cursor-pointer hover:bg-ds-elevated/40',
                  selected && 'bg-ds-primary/5',
                  ragBorderClass(rag),
                )}
              >
                <td className="py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.material_code}`}
                    checked={selected}
                    onChange={(e) => onToggleRow(row.material_id, e.target.checked)}
                    className="h-4 w-4 align-middle"
                  />
                </td>
                <td className="py-2" /> {/* left border rendered via className */}
                <td className="py-2 pr-4 font-mono text-xs text-ds-ink">{row.material_code}</td>
                <td className="py-2 pr-4 text-ds-ink-muted">{[row.board_type_id, row.gsm ? `${row.gsm}g` : null].filter(Boolean).join(' ')}</td>
                <td className="py-2 pr-4 tabular-nums text-ds-ink-muted">{row.size_display}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink">{nf.format(Number(row.available_sheets))}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    title="View reservations / reserve stock"
                    onClick={() => onOpenReservations(row)}
                    className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-ds-primary hover:underline"
                  >
                    {nf.format(reserved)}
                    {reserved > 0 && <ChevronRight size={12} />}
                  </button>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">{nf.format(Number(row.incoming_sheets))}</td>
                <td className={cn('py-2 pr-4 text-right tabular-nums font-medium', Number(row.shortage_sheets) > 0 ? 'text-ds-error' : 'text-ds-ink-muted')}>
                  {nf.format(Number(row.shortage_sheets))}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">
                  {row.daysOfCover != null ? `${row.daysOfCover}d` : '—'}
                </td>
                <td className="py-2 pr-4">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', ragDotClass(rag))} />
                    {suggestion && (
                      <span className="text-[11px] text-[var(--brand-primary)]">
                        ⚡ ~{nf.format(Math.round(suggestion.suggestedKg))} kg
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2 text-right" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => onProcure(row)}
                    className="rounded-ds-sm bg-ds-primary px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
                  >
                    Procure
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
