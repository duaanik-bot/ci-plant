'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  BATCH_STATUS_BADGE_CLASS,
  BATCH_STATUS_LABEL,
  effectiveBatchStatus,
} from '@/lib/planning-batch-decision'
import { readPlanningCore } from '@/lib/planning-decision-spec'
import { dataTable, DataTableFrame } from '@/components/design-system/DataTable'

const cellBase = `align-middle border-b border-ds-line/30 ${dataTable.td.base}`
const filterGhost = dataTable.filter.input

const inp =
  'h-9 w-full min-w-0 rounded-ds-sm border border-ds-line bg-ds-elevated/90 px-2 text-[14px] text-ds-ink tabular-nums transition-[border-color,box-shadow] duration-150 ease-out disabled:opacity-50 focus:border-ds-brand focus:outline-none focus:shadow-ds-focus'

function rowClickTargetOk(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return true
  return !target.closest('input, button, textarea')
}

export type PlanningGridLine = {
  id: string
  cartonId: string | null
  cartonName: string
  cartonSize: string | null
  quantity: number
  rate?: number | null
  directorPriority?: boolean
  artworkCode: string | null
  coatingType: string | null
  otherCoating: string | null
  embossingLeafing: string | null
  paperType: string | null
  gsm: number | null
  remarks: string | null
  planningStatus: string
  specOverrides: Record<string, unknown> | null
  dimLengthMm?: unknown
  dimWidthMm?: unknown
  planningLedger?: {
    numberOfColours?: number | null
  } | null
  po: {
    id: string
    poNumber: string
    poDate: string
    isPriority?: boolean
    customer: { id: string; name: string }
  }
  materialQueue?: {
    boardType?: string | null
    ups?: number
    sheetLengthMm?: unknown
    sheetWidthMm?: unknown
  } | null
  carton?: {
    blankLength?: unknown
    blankWidth?: unknown
    artworkCode?: string | null
    laminateType?: string | null
    coatingType?: string | null
    paperType?: string | null
    gsm?: number | null
    numberOfColours?: number | null
  } | null
  dieMaster?: { id: string; dyeNumber: number; ups: number; sheetSize: string } | null
}

export type PlanningLineFieldPatch = Partial<{
  cartonName: string
  cartonSize: string | null
  quantity: number
  rate: number | null
  remarks: string | null
  gsm: number | null
  paperType: string | null
  coatingType: string | null
  otherCoating: string | null
  embossingLeafing: string | null
}>

export function boardLabel(r: PlanningGridLine): string {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const bg = spec.boardGrade
  if (typeof bg === 'string' && bg.trim()) return bg.trim()
  const mq = r.materialQueue?.boardType
  if (typeof mq === 'string' && mq.trim()) return mq.trim()
  return String(r.paperType ?? r.carton?.paperType ?? '—')
}

type SortKey = 'cartonName' | 'cartonSize' | 'qty' | 'board' | 'batch'

function batchSortId(r: PlanningGridLine): string {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const c = readPlanningCore(spec)
  if (!c.masterSetId) return 'zz-unbatched'
  return c.masterSetId
}

function sortLines(list: PlanningGridLine[], key: SortKey, dir: 'asc' | 'desc'): PlanningGridLine[] {
  const m = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    let cmp = 0
    switch (key) {
      case 'cartonName':
        cmp = a.cartonName.localeCompare(b.cartonName)
        break
      case 'cartonSize':
        cmp = String(a.cartonSize ?? '').localeCompare(String(b.cartonSize ?? ''), undefined, { numeric: true })
        break
      case 'qty':
        cmp = a.quantity - b.quantity
        break
      case 'board':
        cmp = boardLabel(a).localeCompare(boardLabel(b))
        break
      case 'batch': {
        const sa = batchSortId(a)
        const sb = batchSortId(b)
        cmp = sa.localeCompare(sb)
        break
      }
      default:
        cmp = 0
    }
    if (cmp !== 0) return cmp * m
    return a.po.poNumber.localeCompare(b.po.poNumber)
  })
}

export function PlanningDecisionGrid({
  rows,
  ledgerView,
  planningSelection,
  setPlanningSelection,
  onRowBackgroundClick,
  updateRow,
  onSaveLine,
  mixConflictMessage,
  onRecallLine,
}: {
  rows: PlanningGridLine[]
  ledgerView: 'pending' | 'processed'
  planningSelection: Set<string>
  setPlanningSelection: React.Dispatch<React.SetStateAction<Set<string>>>
  onRowBackgroundClick: (lineId: string) => void
  updateRow: (id: string, patch: Partial<PlanningGridLine>) => void
  onSaveLine: (
    lineId: string,
    patch: PlanningLineFieldPatch,
    specSnapshot?: Record<string, unknown> | null,
  ) => Promise<boolean | void>
  mixConflictMessage: string | null
  onRecallLine: (lineId: string) => Promise<void>
}) {
  const [sortKey, setSortKey] = useState<SortKey>('cartonName')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [flash, setFlash] = useState(false)
  const [fCarton, setFCarton] = useState('')
  const [fSize, setFSize] = useState('')
  const [fQty, setFQty] = useState('')
  const [fBoard, setFBoard] = useState('')
  const [fBatch, setFBatch] = useState('')

  useEffect(() => {
    if (!mixConflictMessage) return
    setFlash(true)
    const t = window.setTimeout(() => setFlash(false), 2200)
    return () => window.clearTimeout(t)
  }, [mixConflictMessage])

  const viewRows = useMemo(() => {
    return rows.filter((r) => {
      const pending = r.planningStatus === 'pending'
      if (ledgerView === 'pending') return pending
      return !pending
    })
  }, [rows, ledgerView])

  const filtered = useMemo(() => {
    const match = (hay: string, needle: string) =>
      !needle.trim() || hay.toLowerCase().includes(needle.trim().toLowerCase())
    return viewRows.filter((r) => {
      if (!match(r.cartonName ?? '', fCarton)) return false
      if (!match(String(r.cartonSize ?? ''), fSize)) return false
      if (fQty.trim()) {
        const q = parseInt(fQty, 10)
        if (Number.isFinite(q) && r.quantity !== q) return false
      }
      if (fBoard.trim() && !match(boardLabel(r), fBoard)) return false
      if (fBatch.trim()) {
        const spec = (r.specOverrides || {}) as Record<string, unknown>
        const c = readPlanningCore(spec)
        const hasB = !!(c.masterSetId && c.mixSetMemberIds && c.mixSetMemberIds.length > 0)
        const bStatus = hasB ? effectiveBatchStatus(c) : null
        const idStr = (c.masterSetId ?? '').toLowerCase()
        const label = hasB && bStatus != null ? BATCH_STATUS_LABEL[bStatus].toLowerCase() : 'unbatched'
        const hay = `${idStr} ${label}`.trim()
        if (!match(hay, fBatch)) return false
      }
      return true
    })
  }, [viewRows, fCarton, fSize, fQty, fBoard, fBatch])

  const sorted = useMemo(() => sortLines(filtered, sortKey, sortDir), [filtered, sortKey, sortDir])

  const toggleSort = (k: SortKey) => {
    setSortKey((prev) => {
      if (prev === k) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
        return prev
      }
      setSortDir('asc')
      return k
    })
  }

  const isProcessedRow = (r: PlanningGridLine) => r.planningStatus !== 'pending'

  return (
    <DataTableFrame className="border-ds-line/80 bg-ds-elevated/20">
      {mixConflictMessage ? (
        <div
          className={`shrink-0 px-3 py-1.5 text-[12px] ${
            flash ? 'bg-ds-error/20 text-ds-ink animate-pulse' : 'bg-ds-error/10 text-ds-ink-muted'
          }`}
        >
          {mixConflictMessage}
        </div>
      ) : null}

      <div className={dataTable.wrap}>
        <table className={dataTable.table}>
          <thead className={dataTable.thead}>
            <tr>
              <th
                className={`${dataTable.th} ${dataTable.thSticky} w-10 min-w-0 max-w-10 bg-ds-elevated px-0 text-center text-[10px] text-ds-ink-faint`}
              >
                #
              </th>
              <th className={`${dataTable.th} w-[24%] min-w-0`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('cartonName')}>
                  Carton {sortKey === 'cartonName' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} w-[12%] min-w-0`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('cartonSize')}>
                  Size {sortKey === 'cartonSize' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} w-[10%] min-w-0 text-center`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('qty')}>
                  Qty {sortKey === 'qty' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} w-[22%] min-w-0`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('board')}>
                  Board {sortKey === 'board' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} w-[20%] min-w-0`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('batch')}>
                  Batch {sortKey === 'batch' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
            </tr>
            <tr className="border-b border-ds-line/50 bg-ds-card/20">
              <th className={`${dataTable.th} ${dataTable.thSticky} w-10 bg-ds-elevated px-0`} />
              <th className="px-2 py-2">
                <input
                  className={filterGhost}
                  placeholder="Filter…"
                  value={fCarton}
                  onChange={(e) => setFCarton(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-2 py-2">
                <input
                  className={filterGhost}
                  placeholder="Size"
                  value={fSize}
                  onChange={(e) => setFSize(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-2 py-2">
                <input
                  className={filterGhost + ' text-center'}
                  placeholder="Qty"
                  value={fQty}
                  onChange={(e) => setFQty(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-2 py-2">
                <input
                  className={filterGhost}
                  placeholder="Board"
                  value={fBoard}
                  onChange={(e) => setFBoard(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-2 py-2">
                <input
                  className={filterGhost}
                  placeholder="Batch"
                  value={fBatch}
                  onChange={(e) => setFBatch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => {
              const spec = (r.specOverrides || {}) as Record<string, unknown>
              const planCore = readPlanningCore(spec)
              const processed = isProcessedRow(r)
              const hasBatch = !!(
                planCore.masterSetId &&
                planCore.mixSetMemberIds &&
                planCore.mixSetMemberIds.length > 0
              )
              const bStatus = effectiveBatchStatus(planCore)
              const brd = boardLabel(r)
              const rowSel = !processed && planningSelection.has(r.id)

              return (
                <Fragment key={r.id}>
                  <tr
                    className={`${dataTable.tr.body} ${dataTable.tr.hover} cursor-pointer ${
                      rowSel ? dataTable.tr.selected : idx % 2 === 0 ? 'bg-ds-main/20' : 'bg-ds-elevated/15'
                    }`}
                    onClick={(e) => {
                      if (!rowClickTargetOk(e.target)) return
                      onRowBackgroundClick(r.id)
                    }}
                  >
                    <td
                      className={`${dataTable.th} sticky left-0 z-10 w-10 min-w-0 max-w-10 border-b border-ds-line/30 border-r border-ds-line/50 bg-ds-elevated px-0 text-center ${
                        rowSel ? 'bg-ds-elevated' : ''
                      }`}
                    >
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-[10px] font-bold text-ds-ink-faint">{idx + 1}</span>
                        {processed ? (
                          <button
                            type="button"
                            title="Recall from AW"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-ds-sm border border-ds-line text-ds-ink transition duration-200 hover:border-ds-brand/50 hover:bg-ds-elevated/80"
                            onClick={() => void onRecallLine(r.id)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-ds-brand"
                            checked={planningSelection.has(r.id)}
                            onChange={() => {
                              setPlanningSelection((prev) => {
                                const next = new Set(prev)
                                if (next.has(r.id)) next.delete(r.id)
                                else next.add(r.id)
                                return next
                              })
                            }}
                            aria-label="Select row for batch"
                          />
                        )}
                      </div>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <input
                        className={inp + ' text-[15px] font-semibold text-ds-ink'}
                        disabled={processed}
                        value={r.cartonName}
                        onChange={(e) => updateRow(r.id, { cartonName: e.target.value })}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          if (v) void onSaveLine(r.id, { cartonName: v })
                        }}
                        aria-label="Carton name"
                      />
                    </td>
                    <td className={`${cellBase} ${dataTable.td.secondary} min-w-0`}>
                      <input
                        className={inp + ' text-[13px] text-ds-ink-muted'}
                        disabled={processed}
                        value={r.cartonSize ?? ''}
                        onChange={(e) => updateRow(r.id, { cartonSize: e.target.value || null })}
                        onBlur={(e) => void onSaveLine(r.id, { cartonSize: e.target.value.trim() || null })}
                        aria-label="Size"
                      />
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <input
                        type="number"
                        min={1}
                        className={inp + ' text-center text-[15px] font-semibold text-ds-ink tabular-nums'}
                        disabled={processed}
                        value={r.quantity}
                        onChange={(e) => {
                          const n = Math.max(1, parseInt(e.target.value, 10) || 1)
                          updateRow(r.id, { quantity: n })
                        }}
                        onBlur={(e) => {
                          const n = Math.max(1, parseInt(e.target.value, 10) || 1)
                          void onSaveLine(r.id, { quantity: n })
                        }}
                        aria-label="Quantity"
                      />
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <p
                        className={`${dataTable.td.secondary} truncate text-[13px] font-medium`}
                        title={brd}
                      >
                        {brd}
                      </p>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      {hasBatch ? (
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span
                            className={`inline-flex max-w-full shrink-0 rounded-ds-sm border px-1.5 py-0.5 text-[10px] font-semibold ${
                              BATCH_STATUS_BADGE_CLASS[bStatus]
                            }`}
                          >
                            {BATCH_STATUS_LABEL[bStatus]}
                          </span>
                          <span
                            className="min-w-0 truncate font-mono text-[10px] text-ds-ink-faint"
                            title={planCore.masterSetId ?? ''}
                          >
                            {(planCore.masterSetId ?? '').slice(0, 10)}
                            {String(planCore.masterSetId).length > 10 ? '…' : ''}
                          </span>
                        </div>
                      ) : (
                        <span className={`${dataTable.td.tertiary}`}>—</span>
                      )}
                    </td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
        {sorted.length === 0 ? <p className={dataTable.empty}>No lines in this view.</p> : null}
      </div>
    </DataTableFrame>
  )
}
