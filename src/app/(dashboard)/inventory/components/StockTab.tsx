'use client'

import { cn } from '@/lib/cn'
import { computeRag, ragBorderClass, ragDotClass } from '@/lib/procurement-rag'
import { computeSuggestion } from '@/lib/procurement-suggestions'
import type { PaperWarehouseRow } from '../page'

type Props = {
  rows: PaperWarehouseRow[]
  onRowClick: (row: PaperWarehouseRow) => void
}

const nf = new Intl.NumberFormat('en-IN')

export function StockTab({ rows, onRowClick }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
            <th className="w-1 pb-2" /> {/* RAG border column */}
            <th className="pb-2 pr-4">Material</th>
            <th className="pb-2 pr-4">Board / GSM</th>
            <th className="pb-2 pr-4">Size</th>
            <th className="pb-2 pr-4 text-right">Available</th>
            <th className="pb-2 pr-4 text-right">Reserved</th>
            <th className="pb-2 pr-4 text-right">Incoming</th>
            <th className="pb-2 pr-4 text-right">Shortage</th>
            <th className="pb-2 pr-4 text-right">DoC</th>
            <th className="pb-2">Status</th>
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

            return (
              <tr
                key={row.material_id}
                onClick={() => onRowClick(row)}
                className={cn(
                  'cursor-pointer hover:bg-ds-elevated/40',
                  ragBorderClass(rag),
                )}
              >
                <td className="py-2" /> {/* left border rendered via className */}
                <td className="py-2 pr-4 font-mono text-xs text-ds-ink">{row.material_code}</td>
                <td className="py-2 pr-4 text-ds-ink-muted">{[row.board_type_id, row.gsm ? `${row.gsm}g` : null].filter(Boolean).join(' ')}</td>
                <td className="py-2 pr-4 tabular-nums text-ds-ink-muted">{row.size_display}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink">{nf.format(Number(row.available_sheets))}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">{nf.format(Number(row.reserved_sheets))}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">{nf.format(Number(row.incoming_sheets))}</td>
                <td className={cn('py-2 pr-4 text-right tabular-nums font-medium', Number(row.shortage_sheets) > 0 ? 'text-ds-error' : 'text-ds-ink-muted')}>
                  {nf.format(Number(row.shortage_sheets))}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-ds-ink-muted">
                  {row.daysOfCover != null ? `${row.daysOfCover}d` : '—'}
                </td>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', ragDotClass(rag))} />
                    {suggestion && (
                      <span className="text-[11px] text-ds-warning">
                        ⚡ ~{nf.format(Math.round(suggestion.suggestedKg))} kg
                      </span>
                    )}
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
