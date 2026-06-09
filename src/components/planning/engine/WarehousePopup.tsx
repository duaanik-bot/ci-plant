'use client'

import { useCallback, useEffect, useState } from 'react'
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
  location?: string | null
  supplier?: string | null
  supplier_name?: string | null
  lot?: string | null
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
  onDeselect?: (materialId: string) => Promise<void> | void
  onReserve?: (materialId: string, qty: number) => Promise<void> | void
  onUnreserve?: (materialId: string, qty?: number) => Promise<void> | void
}

// ─── Tabs ────────────────────────────────────────────────────────────────────
const TABS = ['All Stock', 'Matching Stock', 'Suggested Stock', 'Reserved Stock', 'Free Stock'] as const
type Tab = (typeof TABS)[number]

const nf = new Intl.NumberFormat('en-IN')
const fmt = (n: number) => nf.format(n)

function StatTile({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'brand' }) {
  const valueClass =
    tone === 'good'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-700 dark:text-amber-300'
        : tone === 'brand'
          ? 'text-blue-700 dark:text-blue-300'
          : 'text-ds-ink'
  return (
    <div className="min-w-[8rem] rounded-ds-md border border-slate-200 bg-slate-50 px-3 py-2 shadow-ds-depth-sm dark:border-ds-line/35 dark:bg-ds-elevated/55">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-ds-ink-faint">{label}</div>
      <div className={`mt-0.5 text-sm font-bold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}

// ─── Row table ───────────────────────────────────────────────────────────────
function RowTable({
  rows,
  selectedMaterialId,
  lineRequiredSheets,
  lineReservedByMaterial,
  onSelect,
  onDeselect,
  onReserve,
  onUnreserve,
  onActionComplete,
}: {
  rows: WarehouseRow[]
  selectedMaterialId: string | null
  lineRequiredSheets: number
  lineReservedByMaterial: Record<string, number>
  onSelect?: (materialId: string) => Promise<void> | void
  onDeselect?: (materialId: string) => Promise<void> | void
  onReserve?: (materialId: string, qty: number) => Promise<void> | void
  onUnreserve?: (materialId: string, qty?: number) => Promise<void> | void
  onActionComplete?: () => Promise<void> | void
}) {
  const [editing, setEditing] = useState<{ materialId: string; mode: 'reserve' | 'release' } | null>(null)
  const [qty, setQty] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)

  async function run(
    materialId: string,
    fn?: () => Promise<void> | void,
    options: { refreshRows?: boolean; closeEditor?: boolean } = {},
  ) {
    if (!fn) return
    const { refreshRows = true, closeEditor = true } = options
    setBusy(materialId)
    try {
      await fn()
      if (refreshRows) await onActionComplete?.()
    } finally {
      setBusy(null)
      if (closeEditor) setEditing(null)
    }
  }

  if (rows.length === 0) {
    return <div className="py-8 text-center text-sm text-ds-ink-faint">No rows to display.</div>
  }

  const btn =
    'inline-flex h-7 items-center justify-center rounded-ds-sm border px-2.5 text-[11px] font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-45'
  const primaryBtn = `${btn} border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700`
  const selectedBtn = `${btn} border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/35 dark:bg-emerald-500/12 dark:text-emerald-300`
  const reserveBtn = `${btn} border-emerald-300 bg-emerald-100 text-emerald-800 hover:border-emerald-400 hover:bg-emerald-200 dark:border-emerald-500/35 dark:bg-emerald-500/12 dark:text-emerald-300 dark:hover:bg-emerald-500/18`
  const releaseBtn = `${btn} border-amber-300 bg-amber-100 text-amber-800 hover:border-amber-400 hover:bg-amber-200 dark:border-amber-500/35 dark:bg-amber-500/12 dark:text-amber-300 dark:hover:bg-amber-500/18`
  const neutralBtn = `${btn} border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-ds-line/45 dark:bg-ds-card dark:text-ds-ink dark:hover:bg-ds-elevated`

  return (
    <div className="max-h-[52vh] overflow-auto rounded-ds-md border border-slate-200 bg-white dark:border-ds-line/25 dark:bg-ds-card">
      <table className="w-full min-w-[1180px] text-xs">
        <thead className="sticky top-0 z-10 bg-blue-50 dark:bg-ds-elevated">
          <tr className="border-b border-slate-200 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:border-ds-line/30 dark:text-ds-ink-faint">
            <th className="px-3 py-2">Decision</th>
            <th className="px-3 py-2">Board Type</th>
            <th className="px-3 py-2 text-right">GSM</th>
            <th className="px-3 py-2">Size</th>
            <th className="px-3 py-2 text-right">Available</th>
            <th className="px-3 py-2 text-right">Reserved</th>
            <th className="px-3 py-2 text-right">Free</th>
            <th className="px-3 py-2">Location</th>
            <th className="px-3 py-2">Supplier</th>
            <th className="px-3 py-2 text-right">Ageing</th>
            <th className="px-3 py-2">Lot</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const free = Math.max(0, r.available_sheets - r.reserved_sheets)
            const code = r.material_code ?? r.material_id
            const selected = r.material_id === selectedMaterialId
            const lineReserved = lineReservedByMaterial[r.material_id] ?? 0
            const rowBusy = busy === r.material_id
            const editingThisRow = editing?.materialId === r.material_id ? editing.mode : null
            return (
              <tr
                key={r.material_id}
                className={`border-b border-ds-line/15 transition-colors ${
                  selected ? 'bg-blue-100 ring-1 ring-inset ring-blue-300 dark:bg-ds-brand/[0.06] dark:ring-ds-brand/30' : 'hover:bg-blue-50 dark:hover:bg-ds-elevated/50'
                }`}
              >
                <td className="px-3 py-2">
                  <label className="inline-flex items-center gap-2 text-[11px] font-semibold text-ds-ink-muted">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={rowBusy || (selected ? !onDeselect : !onSelect)}
                      onChange={(event) => {
                        const checked = event.target.checked
                        void run(
                          r.material_id,
                          () => (checked ? onSelect?.(r.material_id) : onDeselect?.(r.material_id)),
                          { refreshRows: false },
                        )
                      }}
                      aria-label={`Use ${code} for this plan`}
                      className="h-3.5 w-3.5 rounded border-ds-line/50 bg-ds-elevated text-ds-brand focus:ring-ds-brand/40"
                    />
                    Use
                  </label>
                </td>
                <td className="px-3 py-2">
                  <div className="font-semibold text-ds-ink">{r.board_type_id ?? '—'}</div>
                  <div className="font-mono text-[10px] text-ds-ink-faint">{r.material_code ?? code}</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ds-ink-muted">{r.gsm ?? '—'}</td>
                <td className="px-3 py-2 text-ds-ink-muted">{r.size_display}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ds-ink">{fmt(r.available_sheets)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ds-ink-muted">{fmt(r.reserved_sheets)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-emerald-800 dark:text-ds-success">{fmt(free)}</td>
                <td className="px-3 py-2 text-ds-ink-muted">{r.location ?? '—'}</td>
                <td className="px-3 py-2 text-ds-ink-muted">{r.supplier_name ?? r.supplier ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ds-ink-muted">{r.age_days != null ? `${r.age_days}d` : '—'}</td>
                <td className="px-3 py-2 text-ds-ink-muted">{r.lot ?? '—'}</td>
                <td className="px-3 py-2 text-right">
                  {editingThisRow ? (
                    <div className="inline-flex flex-col items-end gap-1">
                      <span className="inline-flex items-center justify-end gap-1">
                        <input
                          type="number"
                          aria-label={editingThisRow === 'reserve' ? 'Reserve sheets' : 'Release sheets'}
                          value={qty}
                          min={1}
                          max={editingThisRow === 'reserve' ? free : lineReserved}
                          onChange={(e) => setQty(Number(e.target.value) || 0)}
                          className="w-20 rounded-ds-sm border border-slate-200 bg-white px-1.5 py-0.5 text-right text-[11px] text-ds-ink outline-none focus:border-blue-400 dark:border-ds-line/40 dark:bg-ds-elevated"
                        />
                        <button
                          type="button"
                          aria-label={editingThisRow === 'reserve' ? 'Confirm reserve' : 'Confirm release'}
                          disabled={rowBusy}
                          onClick={() =>
                            void run(r.material_id, () => {
                              if (editingThisRow === 'reserve') {
                                return onReserve?.(r.material_id, Math.max(1, Math.min(qty, free)))
                              }
                              return onUnreserve?.(r.material_id, Math.max(1, Math.min(qty, lineReserved)))
                            })
                          }
                          className={editingThisRow === 'reserve' ? reserveBtn : releaseBtn}
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel reserve"
                          onClick={() => setEditing(null)}
                          className={neutralBtn}
                        >
                          ✕
                        </button>
                      </span>
                      <span className="text-[10px] text-ds-ink-faint">
                        {editingThisRow === 'reserve'
                          ? `After: free ${fmt(Math.max(0, free - Math.max(0, Math.min(qty, free))))} sh`
                          : `After: reserved ${fmt(Math.max(0, lineReserved - Math.max(0, Math.min(qty, lineReserved))))} sh`}
                      </span>
                    </div>
                  ) : (
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        aria-label={`${selected ? 'Selected' : 'Select'} ${code}`}
                        disabled={rowBusy || selected || !onSelect}
                        onClick={() => void run(r.material_id, () => onSelect?.(r.material_id), { refreshRows: false })}
                        className={selected ? selectedBtn : primaryBtn}
                      >
                        {selected ? 'Selected' : 'Select'}
                      </button>
                      <button
                        type="button"
                        aria-label={`Reserve ${code}`}
                        disabled={rowBusy || free <= 0 || !onReserve}
                        onClick={() => {
                          const prefill = lineRequiredSheets > 0 ? Math.min(lineRequiredSheets, free) : free
                          setQty(Math.max(1, prefill))
                          setEditing({ materialId: r.material_id, mode: 'reserve' })
                        }}
                        className={reserveBtn}
                      >
                        Reserve
                      </button>
                      <button
                        type="button"
                        aria-label={`Release ${code}`}
                        disabled={rowBusy || lineReserved <= 0 || !onUnreserve}
                        onClick={() => {
                          setQty(Math.max(1, lineReserved))
                          setEditing({ materialId: r.material_id, mode: 'release' })
                        }}
                        className={releaseBtn}
                      >
                        Release{lineReserved > 0 ? ` (${fmt(lineReserved)})` : ''}
                      </button>
                      {selected && onDeselect ? (
                        <button
                          type="button"
                          aria-label={`Deselect ${code}`}
                          disabled={rowBusy}
                          onClick={() => void run(r.material_id, () => onDeselect(r.material_id), { refreshRows: false })}
                          className={neutralBtn}
                        >
                          Deselect
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`View details ${code}`}
                        disabled={rowBusy}
                        className={neutralBtn}
                      >
                        View Details
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
  onDeselect,
  onReserve,
  onUnreserve,
}: WarehousePopupProps) {
  const [rows, setRows] = useState<WarehouseRow[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('All Stock')
  const [search, setSearch] = useState('')

  // Reset search when popup closes
  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  const loadRows = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/inventory/paper-warehouse?rowsOnly=1', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { rows?: WarehouseRow[] }
      setRows(data.rows ?? [])
    } catch {
      // keep existing rows on failure
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void loadRows()
  }, [open, loadRows])

  // Build suggested-material set from readiness
  const suggestedIds = new Set<string>(
    (readiness?.suggestedBoardOptions ?? []).map((o) => o.materialId),
  )

  // Tab filters
  const filtered: WarehouseRow[] = (() => {
    switch (activeTab) {
      case 'All Stock':
        return rows

      case 'Matching Stock': {
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

      case 'Suggested Stock':
        return rows.filter((r) => suggestedIds.has(r.material_id))

      case 'Reserved Stock':
        return rows.filter((r) => r.reserved_sheets > 0)

      case 'Free Stock':
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

  const totalAvailable = rows.reduce((sum, row) => sum + Number(row.available_sheets || 0), 0)
  const totalReserved = rows.reduce((sum, row) => sum + Number(row.reserved_sheets || 0), 0)
  const totalFree = Math.max(0, totalAvailable - totalReserved)
  const selectedRow = rows.find((row) => row.material_id === readiness?.materialId) ?? null
  const selectedFree = selectedRow
    ? Math.max(0, Number(selectedRow.available_sheets || 0) - Number(selectedRow.reserved_sheets || 0))
    : Number(readiness?.freeSheets ?? 0)
  const shortage = Math.max(0, lineRequiredSheets - selectedFree)

  return (
    <GlobalPopoutModal
      isOpen={open}
      onClose={onClose}
      title="Paper Warehouse Stock"
      size="xl"
      widthClass="w-[calc(100vw-1.5rem)] max-w-[1360px]"
      bodyClassName="overflow-hidden px-3 py-3 md:px-4"
      metadata={`${rows.length} material${rows.length !== 1 ? 's' : ''} in warehouse`}
    >
      <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
        <StatTile label="Total Stock" value={`${fmt(totalAvailable)} sh`} />
        <StatTile label="Reserved" value={`${fmt(totalReserved)} sh`} />
        <StatTile label="Free Stock" value={`${fmt(totalFree)} sh`} tone="good" />
        <StatTile label="Required" value={`${fmt(lineRequiredSheets)} sh`} tone="brand" />
        <StatTile
          label="Coverage"
          value={shortage > 0 ? `Short ${fmt(shortage)} sh` : 'Covered'}
          tone={shortage > 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)] lg:items-center">
        {/* Tab bar */}
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={
                activeTab === tab
                  ? 'rounded-full border border-blue-300 bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-800 transition-colors dark:border-ds-brand/60 dark:bg-ds-brand/15 dark:text-ds-brand'
                  : 'rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 transition-colors hover:border-blue-300 hover:bg-blue-100 hover:text-blue-800 dark:border-ds-line/40 dark:bg-ds-elevated dark:text-ds-ink-muted dark:hover:border-ds-brand/40 dark:hover:text-ds-ink'
              }
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            aria-label="Search warehouse stock"
            placeholder="Search code, board, GSM, size…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-ds-sm border border-slate-200 bg-white px-3 py-1.5 text-xs text-ds-ink placeholder:text-slate-400 outline-none focus:border-blue-400 dark:border-ds-line/40 dark:bg-ds-elevated dark:placeholder:text-ds-ink-faint"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch('')}
              className="shrink-0 rounded-ds-sm border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:ring-1 focus-visible:ring-blue-500/50 dark:border-ds-line/40 dark:bg-ds-elevated dark:text-ds-ink-muted dark:hover:text-ds-ink"
            >
              ✕
            </button>
          ) : null}
        </div>
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
          onDeselect={onDeselect}
          onReserve={onReserve}
          onUnreserve={onUnreserve}
          onActionComplete={loadRows}
        />
      )}
    </GlobalPopoutModal>
  )
}
