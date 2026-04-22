'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  BATCH_STATUS_BADGE_CLASS,
  BATCH_STATUS_LABEL,
  effectiveBatchStatus,
} from '@/lib/planning-batch-decision'
import { readPlanningCore } from '@/lib/planning-decision-spec'

const cellBase =
  'align-middle text-[13px] font-medium text-slate-200 border-b border-[#334155] px-2 py-2'
const cellMono =
  'font-designing-queue text-[13px] font-semibold tabular-nums text-[#FBBF24]'
const theadBtn =
  'inline-flex w-full min-w-0 items-center gap-0.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-[#FBBF24]'
const filterGhost =
  'w-full min-w-0 bg-transparent text-[12px] font-medium text-slate-200 placeholder:text-slate-500 border-0 border-b border-[#334155] rounded-none px-0 py-1 focus:outline-none focus:ring-0 focus:border-b-2 focus:border-[#2563EB]'

const inp =
  'h-8 w-full min-w-0 rounded border border-slate-700/80 bg-slate-950 px-1.5 text-[13px] text-slate-100 disabled:opacity-50'

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

type SortKey = 'cartonName' | 'cartonSize' | 'qty' | 'board' | 'batchKey'

function batchSortKey(r: PlanningGridLine): string {
  const c = readPlanningCore((r.specOverrides || {}) as Record<string, unknown>)
  if (c.masterSetId) return c.masterSetId
  if (c.resolvedSetNumber) return c.resolvedSetNumber
  return ''
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
      case 'batchKey':
        cmp = batchSortKey(a).localeCompare(batchSortKey(b))
        break
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
  const [fBoard, setFBoard] = useState('')
  const [fQty, setFQty] = useState('')

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
      if (!match(boardLabel(r), fBoard)) return false
      if (fQty.trim()) {
        const q = parseInt(fQty, 10)
        if (Number.isFinite(q) && r.quantity !== q) return false
      }
      return true
    })
  }, [viewRows, fCarton, fSize, fBoard, fQty])

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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#334155] bg-[#0F172A]">
      {mixConflictMessage ? (
        <div
          className={`shrink-0 px-3 py-1.5 text-[12px] ${
            flash ? 'bg-rose-900/80 text-rose-100 animate-pulse' : 'bg-rose-950/50 text-rose-200'
          }`}
        >
          {mixConflictMessage}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <table className="w-full table-fixed border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-[#334155] bg-[#1E293B]">
              <th
                className={`${cellBase} w-10 sticky left-0 z-20 border-r border-slate-600/30 bg-white px-0 text-center text-[#0F172A]`}
              >
                <span className="text-[10px] font-bold">#</span>
              </th>
              <th className={`${cellBase} w-[32%] min-w-0`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('cartonName')}>
                  Carton {sortKey === 'cartonName' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} w-[12%]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('cartonSize')}>
                  Size {sortKey === 'cartonSize' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} w-[9%]`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('qty')}>
                  Qty {sortKey === 'qty' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} w-[16%] min-w-0`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('board')}>
                  Board {sortKey === 'board' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${cellBase} w-[22%] min-w-0`}>
                <button type="button" className={theadBtn} onClick={() => toggleSort('batchKey')}>
                  Batch {sortKey === 'batchKey' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
            </tr>
            <tr className="border-b border-[#334155] bg-[#0F172A]">
              <th className="sticky left-0 z-20 w-10 bg-white px-0" />
              <th className="px-1 py-1">
                <input
                  className={filterGhost}
                  placeholder="Filter…"
                  value={fCarton}
                  onChange={(e) => setFCarton(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1">
                <input
                  className={filterGhost}
                  placeholder="Size"
                  value={fSize}
                  onChange={(e) => setFSize(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1">
                <input
                  className={filterGhost}
                  placeholder="Qty"
                  value={fQty}
                  onChange={(e) => setFQty(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-1 py-1">
                <input
                  className={filterGhost}
                  placeholder="Board"
                  value={fBoard}
                  onChange={(e) => setFBoard(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-0 py-1" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => {
              const spec = (r.specOverrides || {}) as Record<string, unknown>
              const planCore = readPlanningCore(spec)
              const processed = isProcessedRow(r)
              const stripe = idx % 2 === 0 ? 'bg-[#0B0F1A]' : 'bg-[#161B26]'
              const hasBatch = !!(planCore.masterSetId && planCore.mixSetMemberIds && planCore.mixSetMemberIds.length > 0)
              const bStatus = effectiveBatchStatus(planCore)

              return (
                <Fragment key={r.id}>
                  <tr
                    className={`${stripe} cursor-pointer transition-colors hover:brightness-110`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('input,button')) return
                      onRowBackgroundClick(r.id)
                    }}
                  >
                    <td
                      className="sticky left-0 z-10 w-10 border-b border-[#334155] border-r border-slate-600/20 bg-white px-0 py-1.5 text-center align-middle"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-[10px] font-bold text-[#0F172A]">{idx + 1}</span>
                        {processed ? (
                          <button
                            type="button"
                            title="Recall from AW"
                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-300 text-[#0F172A] hover:bg-slate-100"
                            onClick={() => void onRecallLine(r.id)}
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        ) : (
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-[#2563EB]"
                            checked={planningSelection.has(r.id)}
                            onChange={() => {
                              setPlanningSelection((prev) => {
                                const next = new Set(prev)
                                if (next.has(r.id)) next.delete(r.id)
                                else next.add(r.id)
                                return next
                              })
                            }}
                            aria-label="Select row"
                          />
                        )}
                      </div>
                    </td>
                    <td className={`${cellBase} min-w-0`} onClick={(e) => e.stopPropagation()}>
                      <div className="min-w-0">
                        <input
                          className={inp + ' font-medium'}
                          disabled={processed}
                          value={r.cartonName}
                          onChange={(e) => updateRow(r.id, { cartonName: e.target.value })}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            if (v) void onSaveLine(r.id, { cartonName: v })
                          }}
                        />
                        <p className={`mt-0.5 truncate pl-0.5 text-[10px] text-slate-500 ${cellMono}`}>
                          {r.po.poNumber} · {r.po.customer.name}
                        </p>
                      </div>
                    </td>
                    <td className={cellBase} onClick={(e) => e.stopPropagation()}>
                      <input
                        className={inp + ' tabular-nums'}
                        disabled={processed}
                        value={r.cartonSize ?? ''}
                        onChange={(e) => updateRow(r.id, { cartonSize: e.target.value || null })}
                        onBlur={(e) => void onSaveLine(r.id, { cartonSize: e.target.value.trim() || null })}
                      />
                    </td>
                    <td className={cellBase} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        min={1}
                        className={inp + ' tabular-nums text-[#FBBF24]'}
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
                      />
                    </td>
                    <td
                      className={`${cellBase} min-w-0 text-[12px] text-slate-300`}
                      title={boardLabel(r)}
                    >
                      <span className="line-clamp-2 break-words">{boardLabel(r)}</span>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      {hasBatch ? (
                        <div className="min-w-0">
                          <p className={`truncate text-[10px] font-mono text-slate-500`} title={planCore.masterSetId ?? ''}>
                            {(planCore.masterSetId ?? '').slice(0, 16)}
                            {String(planCore.masterSetId).length > 16 ? '…' : ''}
                          </p>
                          <span
                            className={`mt-0.5 inline-flex max-w-full rounded border px-1.5 py-0.5 text-[9px] font-bold ${
                              BATCH_STATUS_BADGE_CLASS[bStatus]
                            }`}
                          >
                            {BATCH_STATUS_LABEL[bStatus]}
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
        {sorted.length === 0 ? (
          <p className="px-4 py-6 text-center text-slate-500 text-sm">No lines in this view.</p>
        ) : null}
      </div>
    </div>
  )
}
