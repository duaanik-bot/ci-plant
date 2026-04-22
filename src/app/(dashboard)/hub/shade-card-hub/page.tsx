'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Download, RefreshCw, Star } from 'lucide-react'
import { toast } from 'sonner'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { HubCardDeleteAction } from '@/components/hub/HubCardDeleteAction'
import { ShadeCardKanbanBoard } from '@/components/hub/ShadeCardKanbanBoard'
import {
  ShadeCardSpotlightDrawer,
  type ShadeCardSpotlightRow,
} from '@/components/hub/ShadeCardSpotlightDrawer'
import {
  shadeCardAgeTier,
  shadeCardIsApproachingHardExpiry,
  shadeCardIsFadingStandard,
} from '@/lib/shade-card-age'
import { shadeCardKanbanColumn, type ShadeKanbanColumnId } from '@/lib/shade-card-kanban'
import { ShadeSmartRemark } from '@/components/hub/ShadeSmartRemark'
import {
  INDUSTRIAL_PRIORITY_ROW_CLASS,
  INDUSTRIAL_PRIORITY_STAR_ICON_CLASS,
} from '@/lib/industrial-priority-ui'

const mono =
  'font-[family-name:var(--font-designing-queue),ui-monospace,monospace] tabular-nums tracking-tight'

const VIEW_STORAGE = 'shade-hub-view-mode'

type HubLaneFilter = 'all' | ShadeKanbanColumnId

function rowMatchesLaneFilter(row: ShadeCardSpotlightRow, lane: HubLaneFilter): boolean {
  if (lane === 'all') return true
  return shadeCardKanbanColumn(row) === lane
}

export default function ShadeCardHubPage() {
  const [q, setQ] = useState('')
  const [laneFilter, setLaneFilter] = useState<HubLaneFilter>('all')
  const [rows, setRows] = useState<ShadeCardSpotlightRow[]>([])
  const [loading, setLoading] = useState(true)
  const [spotlight, setSpotlight] = useState<ShadeCardSpotlightRow | null>(null)
  const [viewMode, setViewMode] = useState<'table' | 'kanban'>('table')

  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_STORAGE)
      if (v === 'kanban' || v === 'table') setViewMode(v)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE, viewMode)
    } catch {
      /* ignore */
    }
  }, [viewMode])

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      const r = await fetch(`/api/hub/shade-card-hub?${params}`)
      const j = await r.json()
      setRows(Array.isArray(j.rows) ? j.rows : [])
    } catch {
      setRows([])
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [q])

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200)
    return () => window.clearTimeout(t)
  }, [load])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load({ silent: true })
    }, 12_000)
    return () => window.clearInterval(id)
  }, [load])

  const fadingStandardsCount = useMemo(
    () => rows.filter((r) => shadeCardIsFadingStandard(r.currentAgeMonths ?? null)).length,
    [rows],
  )

  const filteredRows = useMemo(
    () => rows.filter((r) => rowMatchesLaneFilter(r, laneFilter)),
    [rows, laneFilter],
  )

  const exportPrimary = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      if (laneFilter !== 'all') params.set('lane', laneFilter)
      const r = await fetch(`/api/hub/shade-card-hub/export?${params}`)
      if (!r.ok) {
        toast.error('Export failed')
        return
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `shade-card-high-intensity-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Export downloaded')
    } catch {
      toast.error('Export failed')
    }
  }, [q, laneFilter])

  return (
    <div className="min-h-screen bg-background text-ds-ink">
      <div className="max-w-[1600px] mx-auto p-3 md:p-4 space-y-4 pb-20">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-ds-warning tracking-tight font-sans">Shade Card Hub</h1>
            <p className="text-[11px] text-neutral-500 mt-0.5 font-sans">
              Live product sync (12s refresh) · 30.44 d/mo age · custody logged in spotlight
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className={`rounded-lg border border-orange-900/40 bg-ds-main px-3 py-2 ${mono}`}
              title="ΔE Limit Enforced < 2.0"
            >
              <p className="text-[9px] uppercase tracking-wider text-neutral-500">Fading Standards</p>
              <p className="text-xl font-bold text-orange-400 tabular-nums leading-tight">{fadingStandardsCount}</p>
            </div>
            <button
              type="button"
              onClick={() => void exportPrimary()}
              className={`inline-flex items-center gap-1.5 rounded-lg border-2 border-ds-warning/70 bg-ds-warning/10 px-3 py-1.5 text-xs font-semibold text-ds-warning shadow-[0_0_12px_rgba(245,158,11,0.15)] hover:bg-ds-warning/10 ${mono}`}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              High-Intensity Export
            </button>
            <div
              className={`flex rounded-lg border border-ds-line/50 overflow-hidden p-0.5 bg-ds-main ${mono}`}
              role="group"
              aria-label="View mode"
            >
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  viewMode === 'table'
                    ? 'bg-ds-elevated text-foreground'
                    : 'text-neutral-500 hover:text-neutral-400'
                }`}
              >
                Table
              </button>
              <button
                type="button"
                onClick={() => setViewMode('kanban')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  viewMode === 'kanban'
                    ? 'bg-ds-elevated text-foreground'
                    : 'text-neutral-500 hover:text-neutral-400'
                }`}
              >
                Kanban
              </button>
            </div>
            <Link
              href="/hub/shade_cards"
              className={`text-xs px-3 py-1.5 rounded-lg border border-ds-line/50 text-neutral-400 hover:bg-ds-card ${mono}`}
            >
              Floor / custody
            </Link>
          </div>
        </header>

        <HubCategoryNav active="shade_cards" />

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search shade, product, customer…"
            className={`flex-1 min-w-[200px] max-w-md rounded-lg border border-ds-line/50 bg-card px-3 py-2 text-sm text-foreground placeholder:text-neutral-600 ${mono}`}
            aria-label="Search shade cards"
          />
          <label className={`flex items-center gap-2 text-xs text-neutral-500 font-sans shrink-0`}>
            <span className="hidden sm:inline">Filter</span>
            <select
              value={laneFilter}
              onChange={(e) => setLaneFilter(e.target.value as HubLaneFilter)}
              className={`rounded-lg border border-ds-line/50 bg-card px-2 py-2 text-sm text-ds-ink min-w-[11rem] ${mono}`}
              aria-label="Filter by hub lane"
            >
              <option value="all">All lanes</option>
              <option value="in_stock">In-Stock</option>
              <option value="on_floor">On-Floor</option>
              <option value="reverify">Re-Verify (9m+)</option>
              <option value="expired">Expired (12m+)</option>
            </select>
          </label>
        </div>

        <AnimatePresence mode="wait">
          {viewMode === 'table' ? (
            <motion.div
              key="table"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className={`overflow-x-auto rounded-xl border border-ds-line/40 bg-background ${mono}`}
            >
          <p className="px-3 py-2 text-[10px] uppercase tracking-wider text-neutral-600 border-b border-ds-line/30 font-sans">
            Audit ledger
          </p>
          <table className="w-full text-left text-xs bg-background">
            <thead className="bg-background border-b border-ds-line/30 text-[10px] uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-3 h-[40px] align-middle min-w-[12rem] font-sans">Identity</th>
                <th className="px-3 h-[40px] align-middle whitespace-nowrap min-w-[6rem]">Shade · AW</th>
                <th className="px-3 h-[40px] align-middle whitespace-nowrap">Age (mo)</th>
                <th className="px-3 h-[40px] align-middle font-sans whitespace-nowrap">Status</th>
                <th className="px-3 h-[40px] align-middle font-sans min-w-[7rem]">Current Custody</th>
                <th className="px-3 h-[40px] align-middle font-sans min-w-[8rem]">Remarks</th>
                <th className="px-2 h-[40px] align-middle w-12 font-sans text-right"> </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ds-card bg-background">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-neutral-500 text-center font-sans">
                    Loading…
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-neutral-600 text-center font-sans">
                    {rows.length === 0 ? 'No shade cards match.' : 'No cards in this lane for the current search.'}
                  </td>
                </tr>
              ) : (
                filteredRows.map((r) => {
                  const months = r.currentAgeMonths ?? null
                  const tier = shadeCardAgeTier(months)
                  const clientName =
                    r.product?.customer?.name?.trim() || r.customer?.name?.trim() || '—'
                  const productName =
                    r.product?.cartonName?.trim() || r.productMaster?.trim() || '—'
                  const productLinkId = r.product?.id ?? r.productId ?? null
                  const aw = r.masterArtworkRef?.trim() || r.product?.artworkCode?.trim() || '—'
                  const ageLabel = months == null ? '—' : months.toFixed(2)
                  const approaching = shadeCardIsApproachingHardExpiry(months)

                  const statusBadge =
                    tier === 'expired'
                      ? { label: 'Expired (12m+)', cls: 'bg-rose-950/80 text-rose-200 border-rose-500/40' }
                      : tier === 'reverify'
                        ? { label: 'Re-verify (9m+)', cls: 'bg-ds-warning/10 text-ds-warning border-ds-warning/45' }
                        : r.custodyStatus === 'on_floor'
                          ? { label: 'On-Floor', cls: 'bg-sky-950/50 text-sky-200 border-sky-700/40' }
                          : { label: 'In-Stock', cls: 'bg-ds-elevated text-neutral-400 border-ds-line/50' }

                  return (
                    <tr
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSpotlight(r)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSpotlight(r)
                        }
                      }}
                      className={`h-[44px] max-h-[44px] hover:bg-ds-main/50 cursor-pointer ${
                        r.fadeAlert ? 'ring-1 ring-red-900/40' : ''
                      } ${tier === 'expired' ? 'bg-rose-500/20' : ''} ${
                        r.industrialPriority ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''
                      }`}
                    >
                      <td className="px-3 align-middle min-w-0 font-sans">
                        <div className="flex items-start gap-1.5 min-w-0">
                          {r.industrialPriority ? (
                            <Star
                              className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`}
                              aria-label="Industrial priority"
                            />
                          ) : (
                            <span className="w-3.5 shrink-0" aria-hidden />
                          )}
                          <div className="min-w-0 flex-1">
                            {productLinkId ? (
                              <Link
                                href={`/product/${productLinkId}`}
                                className="block min-w-0 rounded hover:bg-ds-card/50 -m-0.5 p-0.5"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <p className="font-bold text-emerald-400 truncate leading-tight text-[11px]">
                                  {clientName}
                                </p>
                                <p className="truncate text-sm text-foreground">{productName}</p>
                              </Link>
                            ) : (
                              <>
                                <p className="font-bold text-emerald-400 truncate leading-tight text-[11px]">
                                  {clientName}
                                </p>
                                <p className="truncate text-sm text-foreground">{productName}</p>
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className={`px-3 align-middle text-neutral-400 ${mono}`}>
                        <div className="leading-tight">
                          <span className="whitespace-nowrap block text-[11px] text-ds-warning/90">{r.shadeCode}</span>
                          <span className="whitespace-nowrap text-neutral-500">{aw}</span>
                        </div>
                      </td>
                      <td className="px-3 align-middle whitespace-nowrap">
                        {months == null ? (
                          <span className="text-neutral-600">—</span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 ${mono}`}>
                            {approaching ? (
                              <span
                                className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full border border-ds-warning/60 bg-ds-warning/8 px-0.5 text-[9px] font-black text-ds-warning animate-pulse"
                                title="11–12 months: hard expiry window — open spotlight for audit trail."
                              >
                                !
                              </span>
                            ) : null}
                            {tier === 'fresh' ? (
                              <span className="text-[10px] font-medium text-emerald-500">{ageLabel}</span>
                            ) : tier === 'reverify' ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-ds-warning">
                                <RefreshCw className="h-3 w-3 shrink-0 animate-pulse" aria-hidden />
                                {ageLabel}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-rose-500">
                                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                                {ageLabel}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-3 align-middle font-sans">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-medium border ${statusBadge.cls}`}
                        >
                          {statusBadge.label}
                        </span>
                      </td>
                      <td className="px-3 align-middle font-sans min-w-0">
                        {r.custodyStatus === 'on_floor' &&
                        (r.issuedOperator?.trim() || r.currentHolder?.trim()) ? (
                          <span
                            className={`inline-flex max-w-full truncate rounded-md border border-sky-400/80 bg-ds-main px-2 py-0.5 text-[9px] font-semibold text-sky-100 ${mono}`}
                            title="Current holder on floor"
                          >
                            {r.issuedOperator?.trim() || '—'} @ {r.currentHolder?.trim() || '—'}
                          </span>
                        ) : (
                          <span className={`text-neutral-600 text-[10px] ${mono}`}>—</span>
                        )}
                      </td>
                      <td className="px-3 align-middle max-w-[10rem]" onClick={(e) => e.stopPropagation()}>
                        <ShadeSmartRemark
                          text={r.remarks}
                          editedBy={r.remarksEditedByName}
                          editedAtIso={r.remarksEditedAt}
                          updatedAtIso={r.updatedAt}
                          monoClass={mono}
                        />
                      </td>
                      <td
                        className="px-1 align-middle w-12"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <div className="flex justify-end">
                          <HubCardDeleteAction
                            asset="shade_card"
                            recordId={r.id}
                            triggerClassName="relative"
                            onDeleted={() => {
                              setRows((prev) => prev.filter((x) => x.id !== r.id))
                              setSpotlight((sp) => (sp?.id === r.id ? null : sp))
                              void load({ silent: true })
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
            </motion.div>
          ) : (
            <motion.div
              key="kanban"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="rounded-xl border border-ds-line/40 bg-background p-3 overflow-x-auto"
            >
              {loading ? (
                <p className={`text-neutral-500 text-sm py-8 text-center font-sans ${mono}`}>Loading…</p>
              ) : filteredRows.length === 0 ? (
                <p className="text-neutral-600 text-sm py-8 text-center font-sans">
                  {rows.length === 0 ? 'No shade cards match.' : 'No cards in this lane for the current search.'}
                </p>
              ) : (
                <>
                  <ShadeCardKanbanBoard
                    rows={filteredRows}
                    monoClass={mono}
                    onCardClick={(r) => setSpotlight(r)}
                    onDataChange={() => void load({ silent: true })}
                  />
                  <p className={`text-[10px] text-neutral-600 mt-2 font-sans ${mono}`}>
                    Click card for spotlight. Drag the grip (left) to <strong className="text-neutral-500">On-Floor</strong> or{' '}
                    <strong className="text-neutral-500">In-Stock</strong> to run issue / receive.
                  </p>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <p
          className={`text-center text-[9px] text-neutral-500 pt-4 border-t border-ds-line/30 font-[family-name:var(--font-designing-queue)] tracking-tight`}
        >
          Audit Trail Synchronized - Accountability Layer Active.
        </p>
      </div>
      <ShadeCardSpotlightDrawer
        row={spotlight}
        onClose={() => setSpotlight(null)}
        onSaved={() => void load()}
      />
    </div>
  )
}
