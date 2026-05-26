'use client'

import { useEffect, useState } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import type { PlanningEngineReadiness } from './types'

// ─── API row shape returned by /api/inventory/paper-warehouse ───────────────
type WarehouseRow = {
  material_id: string
  material_code: string | null
  board_type_id: string | null
  board_classification_id: string | null
  gsm: number | null
  size_display: string
  available_sheets: number
  reserved_sheets: number
  incoming_sheets: number
  shortage_sheets: number
  status: string
  est_value_inr: number
  age_days: number
  ageing_risk: string
  daysOfCover: number | null
}

// ─── Props ───────────────────────────────────────────────────────────────────
export type WarehousePopupProps = {
  open: boolean
  onClose: () => void
  lineBoardType?: string | null
  lineGsm?: number | null
  readiness: PlanningEngineReadiness | null
  gsmTolerance?: number
  lineRequiredSheets?: number
  lineReservedByMaterial?: Record<string, number>
  onSelect?: (materialId: string) => Promise<void> | void
  onReserve?: (materialId: string, qty: number) => Promise<void> | void
  onUnreserve?: (materialId: string) => Promise<void> | void
}

// ─── Tabs ────────────────────────────────────────────────────────────────────
const TABS = ['Full stock', 'Filtered matching', 'Suggested only', 'Reserved', 'Free'] as const
type Tab = (typeof TABS)[number]

const nf = new Intl.NumberFormat('en-IN')
const fmt = (n: number) => nf.format(n)

// ─── Row table ───────────────────────────────────────────────────────────────
function RowTable({
  rows,
  selectedMaterialId,
  lineRequiredSheets,
  lineReservedByMaterial,
  onSelect,
  onReserve,
  onUnreserve,
}: {
  rows: WarehouseRow[]
  selectedMaterialId: string | null
  lineRequiredSheets: number
  lineReservedByMaterial: Record<string, number>
  onSelect?: (materialId: string) => Promise<void> | void
  onReserve?: (materialId: string, qty: number) => Promise<void> | void
  onUnreserve?: (materialId: string) => Promise<void> | void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [qty, setQty] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)

  async function run(materialId: string, fn?: () => Promise<void> | void) {
    if (!fn) return
    setBusy(materialId)
    try {
      await fn()
    } finally {
      setBusy(null)
      setEditing(null)
    }
  }

  if (rows.length === 0) {
    return <div className="py-8 text-center text-sm text-ds-ink-faint">No rows to display.</div>
  }

  const btn =
    'rounded-ds-sm border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-ds-line/30 text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
            <th className="pb-2 pr-3">Material code</th>
            <th className="pb-2 pr-3">Board type</th>
            <th className="pb-2 pr-3 text-right">GSM</th>
            <th className="pb-2 pr-3">Size</th>
            <th className="pb-2 pr-3 text-right">Available</th>
            <th className="pb-2 pr-3 text-right">Reserved</th>
            <th className="pb-2 pr-3 text-right">Free</th>
            <th className="pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const free = Math.max(0, r.available_sheets - r.reserved_sheets)
            const code = r.material_code ?? r.material_id
            const selected = r.material_id === selectedMaterialId
            const lineReserved = lineReservedByMaterial[r.material_id] ?? 0
            const rowBusy = busy === r.material_id
            return (
              <tr
                key={r.material_id}
                className={`border-b border-ds-line/15 transition-colors ${
                  selected ? 'bg-ds-brand/[0.06] ring-1 ring-inset ring-ds-brand/30' : 'hover:bg-ds-elevated/50'
                }`}
              >
                <td className="py-2 pr-3 font-mono font-medium text-ds-ink">{r.material_code ?? '—'}</td>
                <td className="py-2 pr-3 text-ds-ink-muted">{r.board_type_id ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-ds-ink-muted">{r.gsm ?? '—'}</td>
                <td className="py-2 pr-3 text-ds-ink-muted">{r.size_display}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-ds-ink">{fmt(r.available_sheets)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-ds-ink-muted">{fmt(r.reserved_sheets)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-emerald-400">{fmt(free)}</td>
                <td className="py-2 text-right">
                  {editing === r.material_id ? (
                    <span className="inline-flex items-center justify-end gap-1">
                      <input
                        type="number"
                        aria-label="Reserve sheets"
                        value={qty}
                        min={1}
                        max={free}
                        onChange={(e) => setQty(Number(e.target.value) || 0)}
                        className="w-20 rounded-ds-sm border border-ds-line/40 bg-ds-elevated px-1.5 py-0.5 text-right text-[11px] text-ds-ink outline-none focus:border-ds-brand/50"
                      />
                      <button
                        type="button"
                        aria-label="Confirm reserve"
                        disabled={rowBusy}
                        onClick={() =>
                          void run(r.material_id, () =>
                            onReserve?.(r.material_id, Math.max(1, Math.min(qty, free))),
                          )
                        }
                        className={`${btn} border-emerald-500/40 bg-emerald-500/15 text-emerald-300`}
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        aria-label="Cancel reserve"
                        onClick={() => setEditing(null)}
                        className={`${btn} border-ds-line/40 bg-ds-elevated text-ds-ink-muted`}
                      >
                        ✕
                      </button>
                    </span>
                  ) : (
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        aria-label={`${selected ? 'Selected' : 'Select'} ${code}`}
                        disabled={rowBusy || selected || !onSelect}
                        onClick={() => void run(r.material_id, () => onSelect?.(r.material_id))}
                        className={`${btn} ${
                          selected
                            ? 'border-ds-brand/50 bg-ds-brand/15 text-ds-brand'
                            : 'border-ds-line/40 bg-ds-elevated text-ds-ink-muted hover:text-ds-ink'
                        }`}
                      >
                        {selected ? 'Selected' : 'Select'}
                      </button>
                      <button
                        type="button"
                        aria-label={`Reserve ${code}`}
                        disabled={rowBusy || free <= 0 || !onReserve}
                        onClick={() => {
                          setQty(Math.max(1, Math.min(lineRequiredSheets || 0, free) || 1))
                          setEditing(r.material_id)
                        }}
                        className={`${btn} border-ds-brand/40 bg-ds-brand/10 text-ds-brand hover:bg-ds-brand/20`}
                      >
                        Reserve
                      </button>
                      <button
                        type="button"
                        aria-label={`Release ${code}`}
                        disabled={rowBusy || lineReserved <= 0 || !onUnreserve}
                        onClick={() => void run(r.material_id, () => onUnreserve?.(r.material_id))}
                        className={`${btn} border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20`}
                      >
                        Release
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────
export function WarehousePopup({
  open,
  onClose,
  lineBoardType,
  lineGsm,
  readiness,
  gsmTolerance = 10,
  lineRequiredSheets = 0,
  lineReservedByMaterial = {},
  onSelect,
  onReserve,
  onUnreserve,
}: WarehousePopupProps) {
  const [rows, setRows] = useState<WarehouseRow[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('Full stock')
  const [search, setSearch] = useState('')

  // Reset search when popup closes
  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  // Fetch once when the popup opens
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    fetch('/api/inventory/paper-warehouse', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ rows: WarehouseRow[] }>
      })
      .then((data) => {
        if (!cancelled) {
          setRows(data.rows ?? [])
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Build suggested-material set from readiness
  const suggestedIds = new Set<string>(
    (readiness?.suggestedBoardOptions ?? []).map((o) => o.materialId),
  )

  // Tab filters
  const filtered: WarehouseRow[] = (() => {
    switch (activeTab) {
      case 'Full stock':
        return rows

      case 'Filtered matching': {
        const hasBoardFilter = lineBoardType != null && lineBoardType !== ''
        const hasGsmFilter = lineGsm != null && Number.isFinite(lineGsm)
        if (!hasBoardFilter && !hasGsmFilter) return rows
        return rows.filter((r) => {
          const boardMatch = hasBoardFilter
            ? (r.board_type_id ?? '').toLowerCase() === (lineBoardType ?? '').toLowerCase()
            : true
          const gsmMatch = hasGsmFilter
            ? r.gsm != null && Math.abs(r.gsm - (lineGsm ?? 0)) <= gsmTolerance
            : true
          return boardMatch && gsmMatch
        })
      }

      case 'Suggested only':
        return rows.filter((r) => suggestedIds.has(r.material_id))

      case 'Reserved':
        return rows.filter((r) => r.reserved_sheets > 0)

      case 'Free':
        return rows.filter((r) => r.available_sheets - r.reserved_sheets > 0)

      default:
        return rows
    }
  })()

  const q = search.trim().toLowerCase()
  const visible: WarehouseRow[] = q
    ? filtered.filter((r) =>
        [r.material_code ?? '', r.board_type_id ?? '', r.gsm != null ? String(r.gsm) : '', r.size_display]
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    : filtered

  return (
    <GlobalPopoutModal
      isOpen={open}
      onClose={onClose}
      title="Paper Warehouse Stock"
      size="xl"
      metadata={`${rows.length} material${rows.length !== 1 ? 's' : ''} in warehouse`}
    >
      {/* Tab bar */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={
              activeTab === tab
                ? 'rounded-full border border-ds-brand/60 bg-ds-brand/15 px-3 py-1 text-xs font-semibold text-ds-brand transition-colors'
                : 'rounded-full border border-ds-line/40 bg-ds-elevated px-3 py-1 text-xs font-semibold text-ds-ink-muted hover:border-ds-brand/40 hover:text-ds-ink transition-colors'
            }
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="mb-3 flex items-center gap-2">
        <input
          type="text"
          aria-label="Search warehouse stock"
          placeholder="Search code, board, GSM, size…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-ds-sm border border-ds-line/40 bg-ds-elevated px-3 py-1.5 text-xs text-ds-ink placeholder:text-ds-ink-faint outline-none focus:border-ds-brand/50"
        />
        {search ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setSearch('')}
            className="shrink-0 rounded-ds-sm border border-ds-line/40 bg-ds-elevated px-2 py-1.5 text-xs text-ds-ink-muted hover:text-ds-ink focus-visible:ring-1 focus-visible:ring-ds-brand/50"
          >
            ✕
          </button>
        ) : null}
      </div>

      {/* Content */}
      {loading ? (
        <div className="py-8 text-center text-sm text-ds-ink-faint">Loading…</div>
      ) : (
        <RowTable
          rows={visible}
          selectedMaterialId={readiness?.materialId ?? null}
          lineRequiredSheets={lineRequiredSheets}
          lineReservedByMaterial={lineReservedByMaterial}
          onSelect={onSelect}
          onReserve={onReserve}
          onUnreserve={onUnreserve}
        />
      )}
    </GlobalPopoutModal>
  )
}
