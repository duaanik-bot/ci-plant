'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PlanningEngineModal } from '@/components/planning/PlanningEngineModal'
import { Badge } from '@/components/design-system/Badge'

type WarehouseRow = {
  material_id: string
  material_code: string
  board_type_id: string | null
  gsm: number | null
  size_display: string
  available_sheets: number
  reserved_sheets: number
  incoming_sheets: number
  shortage_sheets: number
  status: string
}

type Tab = 'full' | 'matching' | 'suggested' | 'reserved' | 'free'

const TABS: { key: Tab; label: string }[] = [
  { key: 'full', label: 'Full stock' },
  { key: 'matching', label: 'Matching' },
  { key: 'suggested', label: 'Suggested' },
  { key: 'reserved', label: 'Reserved' },
  { key: 'free', label: 'Free' },
]

const nf = new Intl.NumberFormat('en-IN')

function norm(v: string | null | undefined): string {
  return (v || '').trim().toLowerCase()
}

type Props = {
  isOpen: boolean
  onClose: () => void
  /** Line's board type — drives the Matching tab. */
  boardType: string | null
  /** Line's GSM — drives the Matching tab (±20 tolerance). */
  gsm: number | null
  /** Material ids the readiness engine suggested — drives the Suggested tab. */
  suggestedMaterialIds: string[]
  /** Currently linked material (highlighted). */
  currentMaterialId?: string | null
  /** Link a board to the line. When provided, rows are selectable. */
  onSelectBoard?: (materialId: string) => Promise<void> | void
}

export function PlanningWarehouseModal({
  isOpen,
  onClose,
  boardType,
  gsm,
  suggestedMaterialIds,
  currentMaterialId,
  onSelectBoard,
}: Props) {
  const [tab, setTab] = useState<Tab>('matching')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<WarehouseRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch('/api/inventory/paper-warehouse')
      .then((r) => r.json())
      .then((data: { rows?: WarehouseRow[] }) => {
        if (cancelled) return
        setRows(Array.isArray(data.rows) ? data.rows : [])
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load warehouse')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen])

  const suggestedSet = useMemo(() => new Set(suggestedMaterialIds), [suggestedMaterialIds])

  const tabRows = useMemo(() => {
    const reqType = norm(boardType)
    const base = rows.filter((r) => {
      switch (tab) {
        case 'matching':
          return (
            (!reqType || norm(r.board_type_id) === reqType) &&
            (gsm == null || r.gsm == null || Math.abs(Number(r.gsm) - gsm) <= 20)
          )
        case 'suggested':
          return suggestedSet.has(r.material_id)
        case 'reserved':
          return r.reserved_sheets > 0
        case 'free':
          return r.available_sheets - r.reserved_sheets > 0
        case 'full':
        default:
          return true
      }
    })
    const q = query.trim().toLowerCase()
    if (!q) return base
    return base.filter((r) =>
      [r.material_code, r.board_type_id ?? '', r.size_display, String(r.gsm ?? '')]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [rows, tab, boardType, gsm, suggestedSet, query])

  const countFor = useCallback(
    (t: Tab): number => {
      const reqType = norm(boardType)
      return rows.filter((r) => {
        switch (t) {
          case 'matching':
            return (
              (!reqType || norm(r.board_type_id) === reqType) &&
              (gsm == null || r.gsm == null || Math.abs(Number(r.gsm) - gsm) <= 20)
            )
          case 'suggested':
            return suggestedSet.has(r.material_id)
          case 'reserved':
            return r.reserved_sheets > 0
          case 'free':
            return r.available_sheets - r.reserved_sheets > 0
          default:
            return true
        }
      }).length
    },
    [rows, boardType, gsm, suggestedSet],
  )

  return (
    <PlanningEngineModal
      isOpen={isOpen}
      onClose={onClose}
      zIndexClass="z-[210]"
      widthClass="max-w-[1080px]"
      title="Paper warehouse"
      metadata={
        <p className="text-xs text-ds-ink-faint mt-0.5">
          {[boardType, gsm != null ? `${gsm} gsm` : null].filter(Boolean).join(' · ') || 'All boards'} ·
          tap a row to link it to this line
        </p>
      }
      secondaryAction={{ label: 'Close', onClick: onClose }}
    >
      <div className="space-y-3">
        {/* Tabs + search */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  tab === t.key
                    ? 'border-ds-brand/40 bg-ds-brand/15 text-ds-brand'
                    : 'border-ds-line/40 bg-ds-elevated text-ds-ink-muted hover:text-ds-ink'
                }`}
              >
                {t.label}
                <span className="ml-1.5 tabular-nums text-ds-ink-faint">{countFor(t.key)}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search code / board / size"
            aria-label="Search warehouse"
            className="h-8 w-56 rounded-ds-md border border-ds-line/40 bg-ds-elevated px-2.5 text-xs text-ds-ink outline-none focus:border-ds-brand/60"
          />
        </div>

        {/* Table */}
        <div className="overflow-x-auto rounded-ds-md border border-ds-line/40">
          <table className="w-full min-w-[860px] table-auto text-left text-xs">
            <thead className="bg-ds-elevated/40 text-[11px] uppercase tracking-wide text-ds-ink-faint">
              <tr>
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2">Board</th>
                <th className="px-3 py-2">GSM</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2 text-right">Free</th>
                <th className="px-3 py-2 text-right">Reserved</th>
                <th className="px-3 py-2 text-right">Incoming</th>
                <th className="px-3 py-2">Status</th>
                {onSelectBoard ? <th className="px-3 py-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-ds-ink-faint">
                    Loading warehouse…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-red-300">
                    {error}
                  </td>
                </tr>
              ) : tabRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-ds-ink-faint">
                    No matching stock in this view.
                  </td>
                </tr>
              ) : (
                tabRows.map((r) => {
                  const free = Math.max(0, r.available_sheets - r.reserved_sheets)
                  const isCurrent = !!currentMaterialId && r.material_id === currentMaterialId
                  return (
                    <tr
                      key={r.material_id}
                      className={`border-t border-ds-line/20 ${isCurrent ? 'bg-ds-brand/5' : ''}`}
                    >
                      <td className="px-3 py-2 font-id-mono text-ds-ink">
                        {r.material_code}
                        {suggestedSet.has(r.material_id) ? (
                          <Badge tone="brand" className="ml-1.5 text-[9px]">
                            suggested
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-ds-ink-muted">{r.board_type_id ?? '—'}</td>
                      <td className="px-3 py-2 tabular-nums text-ds-ink-muted">{r.gsm ?? '—'}</td>
                      <td className="px-3 py-2 tabular-nums text-ds-ink-muted">{r.size_display}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-300">{nf.format(free)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ds-ink">{nf.format(r.reserved_sheets)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-blue-300">{nf.format(r.incoming_sheets)}</td>
                      <td className="px-3 py-2">
                        <span className="text-ds-ink-faint capitalize">{r.status}</span>
                      </td>
                      {onSelectBoard ? (
                        <td className="px-3 py-2 text-right">
                          {isCurrent ? (
                            <span className="text-[11px] text-ds-brand">Linked</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                void onSelectBoard(r.material_id)
                                onClose()
                              }}
                              className="rounded-full border border-ds-brand/40 bg-ds-brand/10 px-2.5 py-0.5 text-[11px] font-semibold text-ds-brand hover:bg-ds-brand/20 transition-colors"
                            >
                              Link
                            </button>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </PlanningEngineModal>
  )
}
