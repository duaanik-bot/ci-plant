'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/design-system'
import { packingTotal, type PackingConfig } from '@/lib/dispatch-packing'

type PackingConfigEditorProps = {
  value: PackingConfig
  onChange: (next: PackingConfig) => void
  /// Optional reference qty (e.g. PO qty or pasting counter) — shown alongside totals.
  referenceQty?: number | null
  referenceLabel?: string
  disabled?: boolean
}

/**
 * Boxes × Qty-per-Box grid. Two columns, multi-row, auto-totals.
 * Used in the pasting completion drawer (capture) and the dispatch drawer (edit).
 */
export function PackingConfigEditor({
  value,
  onChange,
  referenceQty,
  referenceLabel = 'Reference Qty',
  disabled,
}: PackingConfigEditorProps) {
  const rows = value.length > 0 ? value : [{ boxes: 0, qtyPerBox: 0 }]
  const total = packingTotal(value)
  const delta = referenceQty != null ? total - referenceQty : null

  function update(idx: number, patch: Partial<{ boxes: number; qtyPerBox: number }>) {
    const next = [...rows]
    next[idx] = { ...next[idx], ...patch }
    onChange(next)
  }

  function addRow() {
    onChange([...rows, { boxes: 0, qtyPerBox: 0 }])
  }

  function removeRow(idx: number) {
    const next = rows.filter((_, i) => i !== idx)
    onChange(next.length > 0 ? next : [])
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ds-ink-muted">
        <div>Boxes</div>
        <div>Qty / Box</div>
        <div className="text-right">Sub-total</div>
        <div className="w-7" />
      </div>
      {rows.map((r, idx) => {
        const subtotal = (Number(r.boxes) || 0) * (Number(r.qtyPerBox) || 0)
        return (
          <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
            <input
              type="number"
              min={0}
              value={r.boxes || ''}
              onChange={(e) => update(idx, { boxes: Number(e.target.value) })}
              disabled={disabled}
              placeholder="0"
              className="ds-input tabular-nums"
            />
            <input
              type="number"
              min={0}
              value={r.qtyPerBox || ''}
              onChange={(e) => update(idx, { qtyPerBox: Number(e.target.value) })}
              disabled={disabled}
              placeholder="0"
              className="ds-input tabular-nums"
            />
            <div className="text-right text-sm tabular-nums text-ds-ink">
              {subtotal.toLocaleString('en-IN')}
            </div>
            <button
              type="button"
              onClick={() => removeRow(idx)}
              disabled={disabled || rows.length === 1}
              className="rounded-ds-sm p-1.5 text-ds-ink-faint transition hover:bg-ds-elevated hover:text-[var(--error)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Remove row"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
      <Button
        variant="secondary"
        className="w-full gap-1.5 py-1.5 text-xs"
        onClick={addRow}
        disabled={disabled}
      >
        <Plus className="h-3.5 w-3.5" /> Add row
      </Button>

      <div className="mt-3 flex items-center justify-between rounded-ds-sm border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-xs">
        <span className="text-ds-ink-muted">Total Packed</span>
        <span className="font-semibold tabular-nums text-ds-ink">
          {total.toLocaleString('en-IN')}
        </span>
      </div>
      {referenceQty != null && referenceQty > 0 && (
        <div className="flex items-center justify-between px-1 text-[11px]">
          <span className="text-ds-ink-muted">{referenceLabel}</span>
          <span className="tabular-nums text-ds-ink-muted">
            {referenceQty.toLocaleString('en-IN')}
            {delta != null && delta !== 0 && (
              <span
                className={`ml-2 font-medium ${
                  delta > 0 ? 'text-[var(--warning)]' : 'text-[var(--error)]'
                }`}
              >
                {delta > 0 ? '+' : ''}
                {delta.toLocaleString('en-IN')}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
