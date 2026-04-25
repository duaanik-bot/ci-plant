'use client'

import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Layers, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import {
  applyBatchDecisionAction,
  batchKeyForLine,
  BATCH_STATUS_BADGE_CLASS,
  BATCH_STATUS_LABEL,
  buildBatchGroups,
  effectiveBatchStatus,
  type PlanningBatchDecisionAction,
  type PlanningBatchGroup,
} from '@/lib/planning-batch-decision'
import {
  PLANNING_DESIGNERS,
  mergePlanningMetaDesigner,
  readPlanningCore,
  readPlanningMeta,
  type PlanningDesignerKey,
} from '@/lib/planning-decision-spec'
import { ACTION_PILL_BASE, ICON_BUTTON_BASE, PUSHED_CHIP_CLASS, STATUS_CHIP_BASE } from '@/components/design-system/tokens'
import { dataTable, DataTableFrame } from '@/components/design-system/DataTable'

const cellBase = `align-middle border-b border-ds-line/30 text-[13px] text-ds-ink min-h-[36px] px-2 py-1`
const filterGhost = dataTable.filter.input

const inp =
  'h-7 w-full min-w-0 rounded-ds-sm border border-ds-line bg-ds-elevated/90 px-2 text-[13px] text-ds-ink tabular-nums transition-[border-color,box-shadow] duration-150 ease-out disabled:opacity-50 focus:border-ds-brand focus:outline-none focus:shadow-ds-focus'

const batchBtnApprove =
  `${ACTION_PILL_BASE} min-w-0 shrink-0 border-transparent bg-sky-800/90 px-1.5 py-px text-[10px] text-white hover:bg-sky-700 disabled:cursor-not-allowed`
const batchBtnHold =
  `${ACTION_PILL_BASE} min-w-0 shrink-0 border-transparent bg-ds-warning/20 px-1.5 py-px text-[10px] text-ds-warning hover:bg-ds-warning/30 disabled:cursor-not-allowed`
const batchBtnArtwork =
  `${ACTION_PILL_BASE} min-w-0 shrink-0 border-transparent bg-violet-800/90 px-1.5 py-px text-[10px] text-white hover:bg-violet-700 disabled:cursor-not-allowed`
const batchBtnProduction =
  `${ACTION_PILL_BASE} min-w-0 shrink-0 border-transparent bg-emerald-800/90 px-1.5 py-px text-[10px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed`
const batchBtnResume =
  `${ACTION_PILL_BASE} min-w-0 shrink-0 border-ds-line/60 bg-ds-elevated/90 px-1.5 py-px text-[10px] text-ds-ink hover:bg-ds-elevated disabled:cursor-not-allowed`

function firstSpecCoreForGroup(
  rows: PlanningGridLine[],
  lineIds: string[],
): ReturnType<typeof readPlanningCore> {
  const firstId = lineIds[0]
  const row = firstId ? rows.find((l) => l.id === firstId) : undefined
  return readPlanningCore(
    (row?.specOverrides && typeof row.specOverrides === 'object' ? row.specOverrides : {}) as Record<
      string,
      unknown
    >,
  )
}

function timeAgoShort(dateLike: unknown): string | null {
  if (typeof dateLike !== 'string' || !dateLike) return null
  const ms = Date.now() - new Date(dateLike).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
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
  /** Full spec snapshot (e.g. after meta.ups edit) — sent as PATCH specOverrides as-is. */
  specOverrides: Record<string, unknown>
}>

type DerivedBatchType = 'MIXED' | 'STANDARD'

function printTypeForLine(line: PlanningGridLine): string {
  const spec = (line.specOverrides || {}) as Record<string, unknown>
  const raw = spec.printingProcess ?? spec.printType ?? spec.printingType
  if (typeof raw === 'string' && raw.trim()) return raw.trim().toLowerCase()
  const nc = line.planningLedger?.numberOfColours ?? line.carton?.numberOfColours
  if (typeof nc === 'number' && nc > 0) return `${nc}-colour`
  return '—'
}

function getBatchType(lines: PlanningGridLine[]): DerivedBatchType {
  if (lines.length <= 1) return 'STANDARD'
  const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()
  const sizes = new Set(lines.map((l) => norm(l.cartonSize)))
  const boards = new Set(lines.map((l) => boardLabel(l).toLowerCase()))
  const printTypes = new Set(lines.map((l) => printTypeForLine(l)))
  const coatings = new Set(
    lines.map((l) => norm(l.coatingType) || norm(l.otherCoating) || norm(l.carton?.coatingType) || '—'),
  )
  const gsms = new Set(lines.map((l) => String(l.gsm ?? l.carton?.gsm ?? '')))
  const special = new Set(
    lines.map((l) => {
      const s = (l.specOverrides || {}) as Record<string, unknown>
      const foil = typeof s.foilType === 'string' ? s.foilType.trim() : ''
      const emboss = norm(l.embossingLeafing)
      const spotUv = typeof s.spotUV === 'string' ? s.spotUV.trim().toLowerCase() : ''
      return [foil, emboss, spotUv].filter(Boolean).join('-') || 'none'
    }),
  )
  if (sizes.size > 1 || boards.size > 1 || printTypes.size > 1 || coatings.size > 1 || gsms.size > 1 || special.size > 1) {
    return 'MIXED'
  }
  return 'STANDARD'
}

function linesForBatchGroup(group: PlanningBatchGroup | undefined, allRows: PlanningGridLine[]): PlanningGridLine[] {
  if (!group) return []
  return group.lineIds
    .map((id) => allRows.find((r) => r.id === id))
    .filter((x): x is PlanningGridLine => !!x)
}

function isMixedBatchGroup(group: PlanningBatchGroup | undefined, allRows: PlanningGridLine[]): boolean {
  const lines = linesForBatchGroup(group, allRows)
  return getBatchType(lines) === 'MIXED'
}

function designerHandoffLabel(spec: Record<string, unknown>, planCore: ReturnType<typeof readPlanningCore>): string {
  const dn = spec.planningDesignerDisplayName
  if (typeof dn === 'string' && dn.trim()) return dn.trim()
  const k = planCore.designerKey
  if (k === 'avneet_singh' || k === 'shamsher_inder') return PLANNING_DESIGNERS[k as PlanningDesignerKey]
  const md = readPlanningMeta(spec).designer
  if (typeof md === 'string' && md.trim()) return md.trim()
  return ''
}

function resolveDesignerKey(spec: Record<string, unknown>, planCore: ReturnType<typeof readPlanningCore>): PlanningDesignerKey | '' {
  if (planCore.designerKey === 'avneet_singh' || planCore.designerKey === 'shamsher_inder') {
    return planCore.designerKey
  }
  const disp =
    typeof spec.planningDesignerDisplayName === 'string'
      ? spec.planningDesignerDisplayName.trim().toLowerCase()
      : ''
  if (disp === PLANNING_DESIGNERS.avneet_singh.toLowerCase()) return 'avneet_singh'
  if (disp === PLANNING_DESIGNERS.shamsher_inder.toLowerCase()) return 'shamsher_inder'
  const md = readPlanningMeta(spec).designer
  const metaDesigner = typeof md === 'string' ? md.trim().toLowerCase() : ''
  if (metaDesigner === PLANNING_DESIGNERS.avneet_singh.toLowerCase()) return 'avneet_singh'
  if (metaDesigner === PLANNING_DESIGNERS.shamsher_inder.toLowerCase()) return 'shamsher_inder'
  return ''
}

/** UI-only: gang-print ups saved with meta.ups ≥ 1 reads as a final planner decision. */
function markFieldAsFinal(field: string, active: boolean): string {
  if (field !== 'ups' || !active) return ''
  return 'border border-ds-success/40 bg-ds-success/10'
}

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

function packageKeyForRow(row: PlanningGridLine): string | null {
  const core = readPlanningCore((row.specOverrides || {}) as Record<string, unknown>)
  const members = core.mixSetMemberIds ?? []
  if (core.masterSetId && members.length > 1) return `pack:${core.masterSetId}`
  return null
}

function packageMemberOrder(row: PlanningGridLine): number {
  const core = readPlanningCore((row.specOverrides || {}) as Record<string, unknown>)
  const members = core.mixSetMemberIds ?? []
  const idx = members.indexOf(row.id)
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER
}

/**
 * Keep multi-line package rows adjacent as one block, preserving
 * first-appearance order and member sequence within each package.
 */
function coalescePackageRows(sorted: PlanningGridLine[]): PlanningGridLine[] {
  const groups = new Map<string, PlanningGridLine[]>()
  for (const row of sorted) {
    const k = packageKeyForRow(row)
    if (!k) continue
    const arr = groups.get(k) ?? []
    arr.push(row)
    groups.set(k, arr)
  }
  for (const [k, arr] of Array.from(groups.entries())) {
    arr.sort((a, b) => packageMemberOrder(a) - packageMemberOrder(b))
    groups.set(k, arr)
  }
  const seen = new Set<string>()
  const out: PlanningGridLine[] = []
  for (const row of sorted) {
    const k = packageKeyForRow(row)
    if (!k) {
      out.push(row)
      continue
    }
    if (seen.has(k)) continue
    seen.add(k)
    out.push(...(groups.get(k) ?? [row]))
  }
  return out
}

export function PlanningDecisionGrid({
  rows,
  ledgerView,
  recentlyPushedIds = new Set<string>(),
  planningSelection,
  setPlanningSelection,
  onRowBackgroundClick,
  updateRow,
  onSaveLine,
  mixAdvisoryNote,
  mixConflictMessage,
  onRecallLine,
  onBatchDecision,
  batchActionBusy,
  highlightedRowId = null,
}: {
  rows: PlanningGridLine[]
  ledgerView: 'pending' | 'processed'
  recentlyPushedIds?: Set<string>
  planningSelection: Set<string>
  setPlanningSelection: React.Dispatch<React.SetStateAction<Set<string>>>
  onRowBackgroundClick: (lineId: string) => void
  updateRow: (id: string, patch: Partial<PlanningGridLine>) => void
  onSaveLine: (
    lineId: string,
    patch: PlanningLineFieldPatch,
    specSnapshot?: Record<string, unknown> | null,
  ) => Promise<boolean | void>
  mixAdvisoryNote: string | null
  mixConflictMessage: string | null
  onRecallLine: (lineId: string) => Promise<void>
  onBatchDecision: (
    lineIds: string[],
    action: PlanningBatchDecisionAction,
    holdReason?: string,
    opts?: { suppressToast?: boolean },
  ) => Promise<boolean | void>
  batchActionBusy: boolean
  /** Brief success highlight after recall (production-safe feedback). */
  highlightedRowId?: string | null
}) {
  const [sortKey, setSortKey] = useState<SortKey>('cartonName')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25)
  const [page, setPage] = useState(0)
  const [flash, setFlash] = useState(false)
  const [fCarton, setFCarton] = useState('')
  const [fSize, setFSize] = useState('')
  const [fQty, setFQty] = useState('')
  const [fBoard, setFBoard] = useState('')
  const [fBatch, setFBatch] = useState('')
  const [holdOpenKey, setHoldOpenKey] = useState<string | null>(null)
  const [holdReason, setHoldReason] = useState('')
  const [bulkHoldOpen, setBulkHoldOpen] = useState(false)
  const [bulkHoldReason, setBulkHoldReason] = useState('')
  const [actionFeedbackByLineId, setActionFeedbackByLineId] = useState<
    Record<string, { ok: boolean; text: string }>
  >({})
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const setActionFeedback = (lineId: string, ok: boolean, text: string) => {
    setActionFeedbackByLineId((prev) => ({ ...prev, [lineId]: { ok, text } }))
    window.setTimeout(() => {
      setActionFeedbackByLineId((prev) => {
        if (!(lineId in prev)) return prev
        const next = { ...prev }
        delete next[lineId]
        return next
      })
    }, 3200)
  }

  const batchGroups = useMemo(
    () =>
      buildBatchGroups(
        rows.map((r) => ({
          id: r.id,
          poNumber: r.po.poNumber,
          specOverrides: r.specOverrides,
        })),
      ),
    [rows],
  )

  const groupByKey = useMemo(() => new Map(batchGroups.map((g) => [g.key, g])), [batchGroups])

  useEffect(() => {
    if (!mixConflictMessage) return
    setFlash(true)
    const t = window.setTimeout(() => setFlash(false), 2200)
    return () => window.clearTimeout(t)
  }, [mixConflictMessage])

  const viewRows = useMemo(() => {
    return rows.filter((r) => {
      const pending = r.planningStatus === 'pending'
      if (ledgerView === 'pending') return pending || recentlyPushedIds.has(r.id)
      return !pending
    })
  }, [rows, ledgerView, recentlyPushedIds])

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

  const sorted = useMemo(() => {
    const base = sortLines(filtered, sortKey, sortDir)
    const bucketed =
      ledgerView === 'pending'
        ? [...base].sort((a, b) => {
            const aPushed = recentlyPushedIds.has(a.id) && a.planningStatus !== 'pending' ? 1 : 0
            const bPushed = recentlyPushedIds.has(b.id) && b.planningStatus !== 'pending' ? 1 : 0
            if (aPushed !== bPushed) return aPushed - bPushed
            return 0
          })
        : base
    return coalescePackageRows(bucketed)
  }, [filtered, sortKey, sortDir, ledgerView, recentlyPushedIds])

  // Reset to page 0 when filters/sort/view change
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const paginated = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize)
  const pageStart = sorted.length === 0 ? 0 : safePage * pageSize + 1
  const pageEnd = Math.min((safePage + 1) * pageSize, sorted.length)

  // Reset page on filter/sort/view change
  const prevFiltersRef = useRef({ fCarton, fSize, fQty, fBoard, fBatch, ledgerView, sortKey, sortDir })
  useEffect(() => {
    const prev = prevFiltersRef.current
    if (
      prev.fCarton !== fCarton || prev.fSize !== fSize || prev.fQty !== fQty ||
      prev.fBoard !== fBoard || prev.fBatch !== fBatch || prev.ledgerView !== ledgerView ||
      prev.sortKey !== sortKey || prev.sortDir !== sortDir
    ) {
      setPage(0)
      prevFiltersRef.current = { fCarton, fSize, fQty, fBoard, fBatch, ledgerView, sortKey, sortDir }
    }
  }, [fCarton, fSize, fQty, fBoard, fBatch, ledgerView, sortKey, sortDir])

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
  const selectableRowIds = useMemo(
    () => paginated.filter((r) => !isProcessedRow(r)).map((r) => r.id),
    [paginated],
  )
  const allPageSelected =
    selectableRowIds.length > 0 && selectableRowIds.every((id) => planningSelection.has(id))
  const somePageSelected = selectableRowIds.some((id) => planningSelection.has(id))

  const recallGroupToPlanning = async (groupRows: PlanningGridLine[]) => {
    if (!groupRows.length) return
    let successCount = 0
    let failCount = 0
    for (const row of groupRows) {
      try {
        await onRecallLine(row.id)
        successCount += 1
      } catch {
        failCount += 1
      }
    }
    if (failCount > 0) {
      toast.error(`Recalled ${successCount}/${groupRows.length} item(s)`)
      return
    }
    toast.success(`Recalled ${successCount} item${successCount === 1 ? '' : 's'} to planning`)
  }

  const renderBatchDecisionControls = (
    lineIds: string[],
    groupKey: string,
    mode: 'row' | 'bulk',
  ) => {
    const core = firstSpecCoreForGroup(rows, lineIds)
    const st = effectiveBatchStatus(core)
    const canApprove = applyBatchDecisionAction(core, 'approve_batch') != null
    const canSend = applyBatchDecisionAction(core, 'send_to_artwork') != null
    const onHold = st === 'hold'
    const holdIsOpen = mode === 'row' ? holdOpenKey === groupKey : bulkHoldOpen
    const reasonVal = mode === 'row' ? holdReason : bulkHoldReason
    const setReasonVal = mode === 'row' ? setHoldReason : setBulkHoldReason

    const actionLabel = (action: PlanningBatchDecisionAction) =>
      action === 'approve_batch'
        ? 'Approved'
        : action === 'hold_batch'
          ? 'Held'
          : action === 'send_to_artwork'
            ? 'To Artwork'
            : action === 'release_to_production'
              ? 'To Production'
              : 'Resumed'

    const runAction = async (action: PlanningBatchDecisionAction, holdReasonArg?: string) => {
      const warnIfMissingHandoff = (id: string) => {
        if (action !== 'send_to_artwork') return
        const row = rows.find((x) => x.id === id)
        if (!row) return
        const s = (row.specOverrides || {}) as Record<string, unknown>
        const m = readPlanningMeta(s)
        const designer = designerHandoffLabel(s, readPlanningCore(s))
        const ups = typeof m.ups === 'number' && Number.isFinite(m.ups) && m.ups >= 1 ? m.ups : null
        if (!designer || ups == null) {
          toast.warning('Designer or Ups not set. Proceeding may cause rework.')
        }
      }
      if (mode === 'bulk') {
        let successCount = 0
        let failCount = 0
        for (const id of lineIds) {
          warnIfMissingHandoff(id)
          const ok = (await onBatchDecision([id], action, holdReasonArg, { suppressToast: true })) !== false
          if (ok) successCount += 1
          else failCount += 1
          setActionFeedback(id, ok, ok ? `✓ ${actionLabel(action)}` : `✕ ${actionLabel(action)}`)
        }
        toast.success(`${successCount} updated${failCount ? ` • ${failCount} failed` : ''}`)
        return
      }
      if (action === 'send_to_artwork') {
        const missing = lineIds.some((id) => {
          const row = rows.find((x) => x.id === id)
          if (!row) return false
          const s = (row.specOverrides || {}) as Record<string, unknown>
          const m = readPlanningMeta(s)
          const designer = designerHandoffLabel(s, readPlanningCore(s))
          const ups = typeof m.ups === 'number' && Number.isFinite(m.ups) && m.ups >= 1 ? m.ups : null
          return !designer || ups == null
        })
        if (missing) {
          toast.warning('Designer or Ups not set. Proceeding may cause rework.')
        }
      }
      const ok = (await onBatchDecision(lineIds, action, holdReasonArg, { suppressToast: true })) !== false
      toast.success(`${ok ? lineIds.length : 0} updated${ok ? '' : ` • ${lineIds.length} failed`}`)
      for (const id of lineIds) {
        setActionFeedback(id, ok, ok ? `✓ ${actionLabel(action)}` : `✕ ${actionLabel(action)}`)
      }
    }

    const openHold = () => {
      setReasonVal('')
      if (mode === 'row') {
        setBulkHoldOpen(false)
        setHoldOpenKey((k) => (k === groupKey ? null : groupKey))
      } else {
        setHoldOpenKey(null)
        setBulkHoldOpen((v) => !v)
      }
    }

    const confirmHold = async () => {
      if (!reasonVal.trim()) {
        toast.error('Enter a hold reason')
        return
      }
      if (mode === 'row') {
        const test = applyBatchDecisionAction(core, 'hold_batch', { holdReason: reasonVal.trim() })
        if (!test) {
          toast.error('Cannot hold this group now')
          return
        }
        setHoldOpenKey(null)
        await runAction('hold_batch', reasonVal.trim())
      } else {
        setBulkHoldOpen(false)
        await runAction('hold_batch', reasonVal.trim())
      }
    }

    const bulkTitle = 'Runs once per selected row using that row’s group state'
    const rowTitleApprove = canApprove
      ? 'Mark group ready (approved for next step)'
      : 'Only available from Draft — click to try or see message'

    return (
      <div
        data-batch-actions
        id="fix-action-layout"
        className="flex min-w-0 flex-col items-end gap-0.5"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'row' && onHold && core.batchHoldReason ? (
          <p
            className="order-first max-w-full text-right text-[9px] leading-tight text-rose-200/90 line-clamp-1"
            title={core.batchHoldReason}
          >
            <span className="font-semibold text-rose-300/95">Hold:</span> {core.batchHoldReason}
          </p>
        ) : null}
        <div className="flex min-w-0 flex-nowrap items-center justify-end gap-1 overflow-x-auto">
          <button
            type="button"
            disabled={batchActionBusy}
            title={mode === 'bulk' ? bulkTitle : rowTitleApprove}
            className={batchBtnApprove}
            onClick={(e) => {
              e.stopPropagation()
              void runAction('approve_batch')
            }}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={batchActionBusy}
            className={batchBtnHold}
            onClick={(e) => {
              e.stopPropagation()
              openHold()
            }}
          >
            Hold
          </button>
          <button
            type="button"
            disabled={batchActionBusy}
            title={
              mode === 'bulk'
                ? bulkTitle
                : canSend
                  ? 'Mark approved for artwork'
                  : 'Only ready batches can go to artwork — click to try'
            }
            className={batchBtnArtwork}
            onClick={(e) => {
              e.stopPropagation()
              void runAction('send_to_artwork')
            }}
          >
            To Artwork
          </button>
          <button
            type="button"
            disabled={batchActionBusy}
            title={mode === 'bulk' ? bulkTitle : undefined}
            className={batchBtnProduction}
            onClick={(e) => {
              e.stopPropagation()
              void runAction('release_to_production')
            }}
          >
            To Production
          </button>
          <button
            type="button"
            disabled={batchActionBusy}
            title={mode === 'bulk' ? bulkTitle : undefined}
            className={batchBtnResume}
            onClick={(e) => {
              e.stopPropagation()
              void runAction('resume_from_hold')
            }}
          >
            Resume
          </button>
        </div>
        {holdIsOpen ? (
          <span className="flex w-full min-w-0 flex-nowrap items-center justify-end gap-1">
            <input
              className="min-w-0 max-w-[10rem] flex-1 rounded border border-ds-warning/30 bg-ds-main px-1.5 py-px text-[10px] text-ds-ink"
              placeholder="Reason required"
              value={reasonVal}
              onChange={(e) => setReasonVal(e.target.value)}
            />
            <button
              type="button"
              disabled={batchActionBusy}
              className="shrink-0 rounded bg-rose-800 px-1.5 py-px text-[10px] text-white"
              onClick={(e) => {
                e.stopPropagation()
                void confirmHold()
              }}
            >
              Confirm
            </button>
          </span>
        ) : null}
      </div>
    )
  }

  const bulkLineIds = planningSelection.size > 1 ? Array.from(planningSelection) : []
  const bulkGroupKey = bulkLineIds.length ? `__bulk:${bulkLineIds.join(',')}` : ''

  const bulkSpansMultipleBatches = useMemo(() => {
    if (bulkLineIds.length < 2) return false
    const keys = new Set<string>()
    for (const id of bulkLineIds) {
      const row = rows.find((r) => r.id === id)
      if (!row) continue
      const c = readPlanningCore((row.specOverrides || {}) as Record<string, unknown>)
      keys.add(batchKeyForLine(id, c))
    }
    return keys.size > 1
  }, [bulkLineIds, rows])

  // Visual row entries for grouped rendering
  type VisualEntry =
    | { kind: 'single'; row: PlanningGridLine; pIdx: number }
    | { kind: 'group'; rows: PlanningGridLine[]; groupId: string; batchGroupKey: string; batchGroup: PlanningBatchGroup | undefined; pIdx: number }
    | { kind: 'sub'; row: PlanningGridLine; groupId: string; subIdx: number; pIdx: number }

  const visualRows = useMemo((): VisualEntry[] => {
    const result: VisualEntry[] = []
    const seenGroups = new Set<string>()

    paginated.forEach((r, pIdx) => {
      const spec = (r.specOverrides || {}) as Record<string, unknown>
      const planCore = readPlanningCore(spec)
      const mid = planCore.masterSetId
      const members = planCore.mixSetMemberIds ?? []
      const isGangGroup = !!(mid && members.length > 1)
      const bgKey = batchKeyForLine(r.id, planCore)
      const bg = groupByKey.get(bgKey)

      if (!isGangGroup || (bg?.lineIds.length ?? 0) <= 1) {
        result.push({ kind: 'single', row: r, pIdx })
        return
      }

      if (seenGroups.has(mid!)) {
        if (expandedGroups.has(mid!)) {
          const subIdx = result.filter((e) => e.kind === 'sub' && e.groupId === mid).length
          result.push({ kind: 'sub', row: r, groupId: mid!, subIdx, pIdx })
        }
        return
      }

      seenGroups.add(mid!)

      const groupRows = paginated.filter((pl) => {
        const ps = (pl.specOverrides || {}) as Record<string, unknown>
        return readPlanningCore(ps).masterSetId === mid
      })

      result.push({ kind: 'group', rows: groupRows, groupId: mid!, batchGroupKey: bgKey, batchGroup: bg, pIdx })
    })

    return result
  }, [paginated, expandedGroups, groupByKey])

  return (
    <DataTableFrame className="h-full border-ds-line/80 bg-ds-elevated/20">
      {mixAdvisoryNote ? (
        <div className="shrink-0 border-b border-ds-warning/25 bg-ds-warning/10 px-3 py-1.5 text-[12px] text-ds-ink">
          {mixAdvisoryNote}
        </div>
      ) : null}
      {mixConflictMessage ? (
        <div
          className={`shrink-0 px-3 py-1.5 text-[12px] ${
            flash ? 'bg-ds-error/20 text-ds-ink animate-pulse' : 'bg-ds-error/10 text-ds-ink-muted'
          }`}
        >
          {mixConflictMessage}
        </div>
      ) : null}

      {planningSelection.size > 1 ? (
        <div
          id="fix-bulk-bar"
          className="shrink-0 border-b border-ds-line/50 bg-ds-elevated/35 px-2 py-1.5"
          data-batch-actions
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 pt-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                Group actions · {planningSelection.size} selected
                <span className="ml-1.5 font-normal normal-case text-ds-ink-muted">
                  (one run per row)
                </span>
              </p>
              {bulkSpansMultipleBatches ? (
                <p className="mt-0.5 text-[10px] font-normal normal-case text-ds-warning">
                  Applying action across multiple batches
                </p>
              ) : null}
            </div>
            <div className="min-w-0 flex-1 overflow-x-auto">
              {renderBatchDecisionControls(bulkLineIds, bulkGroupKey, 'bulk')}
            </div>
          </div>
        </div>
      ) : null}

      <div className={dataTable.wrap}>
        <table className={dataTable.table}>
          <thead className={dataTable.thead}>
            <tr>
              <th
                className={`${dataTable.th} ${dataTable.thSticky} min-h-[32px] w-10 min-w-0 max-w-10 bg-ds-elevated px-0 py-1.5 text-center text-[10px] text-ds-ink-faint`}
              >
                <div className="flex flex-col items-center gap-0.5">
                  <span>#</span>
                  {selectableRowIds.length > 0 ? (
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-ds-brand"
                      checked={allPageSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = somePageSelected && !allPageSelected
                      }}
                      onChange={() => {
                        setPlanningSelection((prev) => {
                          const next = new Set(prev)
                          if (allPageSelected) selectableRowIds.forEach((id) => next.delete(id))
                          else selectableRowIds.forEach((id) => next.add(id))
                          return next
                        })
                      }}
                      title={allPageSelected ? 'Deselect all rows on this page' : 'Select all rows on this page'}
                      aria-label={allPageSelected ? 'Deselect all rows on this page' : 'Select all rows on this page'}
                    />
                  ) : null}
                  {planningSelection.size > 0 ? (
                    <span
                      className="rounded border border-ds-brand/35 bg-ds-brand/10 px-1 py-0 text-[9px] font-medium text-ds-brand"
                      title={`${planningSelection.size} selected`}
                    >
                      {planningSelection.size}
                    </span>
                  ) : null}
                </div>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[24%] min-w-0 py-1.5`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('cartonName')}>
                  Carton {sortKey === 'cartonName' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[12%] min-w-0 py-1.5`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('cartonSize')}>
                  Size {sortKey === 'cartonSize' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[10%] min-w-0 py-1.5 text-center`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('qty')}>
                  Qty {sortKey === 'qty' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[14%] min-w-0 py-1.5`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('board')}>
                  Board {sortKey === 'board' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[11%] min-w-0 py-1.5`}>Designer</th>
              <th className={`${dataTable.th} min-h-[32px] w-[11%] min-w-0 py-1.5`}>Set type</th>
              <th className={`${dataTable.th} min-h-[32px] w-[22%] min-w-0 py-1.5 text-right`}>
                <button
                  type="button"
                  className={`${dataTable.thSortBtn} w-full justify-end text-right`}
                  onClick={() => toggleSort('batch')}
                >
                  Group / actions {sortKey === 'batch' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
            </tr>
            <tr className="border-b border-ds-line/50 bg-ds-card/20">
              <th className={`${dataTable.th} ${dataTable.thSticky} min-h-[32px] w-10 bg-ds-elevated px-0 py-1`} />
              <th className="px-2 py-1">
                <input
                  className={filterGhost}
                  placeholder="Filter…"
                  value={fCarton}
                  onChange={(e) => setFCarton(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-2 py-1">
                <input
                  className={filterGhost}
                  placeholder="Size"
                  value={fSize}
                  onChange={(e) => setFSize(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-2 py-1">
                <input
                  className={filterGhost + ' text-center'}
                  placeholder="Qty"
                  value={fQty}
                  onChange={(e) => setFQty(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-2 py-1">
                <input
                  className={filterGhost}
                  placeholder="Board"
                  value={fBoard}
                  onChange={(e) => setFBoard(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-2 py-1" />
              <th className="px-2 py-1" />
              <th className="px-2 py-1">
                <input
                  className={filterGhost}
                  placeholder="Group"
                  value={fBatch}
                  onChange={(e) => setFBatch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {visualRows.map((entry) => {
              // ── GROUP HEADER ROW ──────────────────────────────────────
              if (entry.kind === 'group') {
                const { rows: groupRows, groupId, batchGroupKey, batchGroup, pIdx } = entry
                const firstRow = groupRows[0]!
                const spec0 = (firstRow.specOverrides || {}) as Record<string, unknown>
                const planCore0 = readPlanningCore(spec0)
                const bStatus0 = effectiveBatchStatus(planCore0)
                const batchLineIds0 = batchGroup?.lineIds ?? groupRows.map((r) => r.id)
                const totalGroupQty = groupRows.reduce((s, r) => s + (r.quantity || 0), 0)
                const allBoards = Array.from(new Set(groupRows.map((r) => boardLabel(r))))
                const boardDisplay = allBoards.length === 1 ? allBoards[0]! : 'Mixed'
                const designerLabel0 = designerHandoffLabel(spec0, planCore0)
                const isExpanded = expandedGroups.has(groupId)
                const allGroupSel = groupRows.every((r) => planningSelection.has(r.id))
                const someGroupSel = groupRows.some((r) => planningSelection.has(r.id))
                const allSizes = Array.from(new Set(groupRows.map((r) => String(r.cartonSize ?? '').trim())))
                const sizeDisplay = allSizes.length === 1 ? allSizes[0]! : 'Mixed'
                const groupProcessed = groupRows.every((r) => isProcessedRow(r))
                const groupPushedInPending =
                  ledgerView === 'pending' &&
                  groupRows.every((r) => recentlyPushedIds.has(r.id) && r.planningStatus !== 'pending')

                return (
                  <Fragment key={`group:${groupId}`}>
                    <tr
                      className={`border-l-[3px] border-ds-brand transition-colors ${
                        groupPushedInPending
                          ? 'bg-ds-success/12 hover:bg-ds-success/16'
                          : someGroupSel
                            ? 'bg-ds-brand/12'
                            : 'bg-ds-brand/6 hover:bg-ds-brand/10'
                      }`}
                    >
                      {/* # + group checkbox */}
                      <td
                        className={`${dataTable.th} ${dataTable.thSticky} min-h-[32px] w-10 min-w-0 max-w-10 border-b border-ds-line/30 border-r border-ds-line/50 bg-ds-brand/10 px-0 text-center`}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-[9px] font-bold text-ds-brand">{pIdx + 1}</span>
                          {groupProcessed ? (
                            <button
                              type="button"
                              title="Recall full group from AW — returns all group lines to pending planning"
                              className={`${ICON_BUTTON_BASE} h-7 w-7 rounded-ds-sm border border-ds-success/40 bg-ds-success/10 text-ds-ink duration-200 hover:border-ds-success/60 hover:bg-ds-success/15`}
                              onClick={(e) => {
                                e.stopPropagation()
                                void recallGroupToPlanning(groupRows)
                              }}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-ds-brand"
                              checked={allGroupSel}
                              ref={(el) => { if (el) el.indeterminate = someGroupSel && !allGroupSel }}
                              onChange={() => {
                                setPlanningSelection((prev) => {
                                  const next = new Set(prev)
                                  if (allGroupSel) groupRows.forEach((r) => next.delete(r.id))
                                  else groupRows.forEach((r) => next.add(r.id))
                                  return next
                                })
                              }}
                            />
                          )}
                        </div>
                      </td>

                      {/* Carton — all item names + group badge */}
                      <td className={`${cellBase} min-w-0`}>
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <div className="flex items-center gap-1">
                            <span className="inline-flex items-center gap-0.5 rounded border border-ds-brand/40 bg-ds-brand/15 px-1 py-px text-[9px] font-bold text-ds-brand">
                              <Layers className="h-2.5 w-2.5" aria-hidden /> GANG · {groupRows.length} items
                            </span>
                            <span className="text-[9px] text-ds-ink-faint">{firstRow.po.customer.name}</span>
                          </div>
                          {groupRows.slice(0, 2).map((r) => (
                            <button
                              key={r.id}
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onRowBackgroundClick(r.id) }}
                              className="line-clamp-1 text-left text-[12px] font-semibold text-ds-ink transition-colors hover:text-ds-brand"
                              title={r.cartonName}
                            >
                              {r.cartonName}
                            </button>
                          ))}
                          {groupRows.length > 2 && (
                            <span className="text-[9px] text-ds-ink-faint">+{groupRows.length - 2} more items</span>
                          )}
                        </div>
                      </td>

                      {/* Size */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className={`text-[12px] ${allSizes.length > 1 ? 'text-ds-warning' : 'text-ds-ink-muted'}`}>
                          {sizeDisplay || '—'}
                        </span>
                      </td>

                      {/* Qty — combined */}
                      <td className={`${cellBase} min-w-0 text-center`}>
                        <div className="flex flex-col items-center">
                          <span className="text-[14px] font-bold tabular-nums text-ds-brand">
                            {totalGroupQty.toLocaleString('en-IN')}
                          </span>
                          <span className="text-[9px] text-ds-ink-faint">combined</span>
                        </div>
                      </td>

                      {/* Board */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className={`text-[12px] font-medium ${allBoards.length > 1 ? 'text-ds-warning' : 'text-ds-ink-muted'}`}>
                          {boardDisplay}
                        </span>
                      </td>

                      {/* Designer */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className="text-[12px] text-ds-ink-muted">{designerLabel0 || '—'}</span>
                      </td>

                      {/* Set type */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className="inline-flex items-center rounded border border-ds-brand/35 bg-ds-brand/10 px-1.5 py-px text-[10px] font-semibold text-ds-brand">
                          Gang
                        </span>
                      </td>

                      {/* Group actions + expand */}
                      <td className={`${cellBase} min-w-0 align-middle overflow-visible`}>
                        <div className="flex min-w-0 flex-col items-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
                            <span className={`${STATUS_CHIP_BASE} shrink-0 ${BATCH_STATUS_BADGE_CLASS[bStatus0]}`}>
                              {BATCH_STATUS_LABEL[bStatus0]}
                            </span>
                            <span className="text-[9px] text-ds-ink-faint">{(planCore0.masterSetId ?? '').slice(0, 10)}</span>
                          </div>
                          {renderBatchDecisionControls(batchLineIds0, batchGroupKey, 'row')}
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedGroups((prev) => {
                                const next = new Set(prev)
                                if (next.has(groupId)) next.delete(groupId)
                                else next.add(groupId)
                                return next
                              })
                            }}
                            className="mt-0.5 flex items-center gap-0.5 rounded border border-ds-brand/30 bg-ds-brand/8 px-1.5 py-px text-[9px] font-medium text-ds-brand hover:bg-ds-brand/15 transition-colors"
                          >
                            {isExpanded ? '▲ Hide items' : `▼ Show ${groupRows.length} items`}
                          </button>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                )
              }

              // ── SUB-ROW (expanded group item) ──────────────────────────
              if (entry.kind === 'sub') {
                const r = entry.row
                const spec = (r.specOverrides || {}) as Record<string, unknown>
                const planCore = readPlanningCore(spec)
                const pm = readPlanningMeta(spec)
                const brd = boardLabel(r)
                const upsNum = typeof pm.ups === 'number' && Number.isFinite(pm.ups) && pm.ups >= 1 ? pm.ups : null
                const designerLabelSub = designerHandoffLabel(spec, planCore)
                const subPushedInPending =
                  ledgerView === 'pending' &&
                  recentlyPushedIds.has(r.id) &&
                  r.planningStatus !== 'pending'
                return (
                  <Fragment key={`sub:${r.id}`}>
                    <tr
                      className={`border-l-[3px] border-ds-brand/40 transition-colors ${
                        subPushedInPending ? 'bg-ds-success/10 hover:bg-ds-success/15' : 'bg-ds-brand/3 hover:bg-ds-brand/6'
                      }`}
                    >
                      <td
                        className={`${dataTable.th} ${dataTable.thSticky} min-h-[32px] w-10 min-w-0 max-w-10 border-b border-ds-line/20 border-r border-ds-brand/20 bg-ds-brand/5 px-0 text-center`}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-[8px] text-ds-brand/60">↳</span>
                          <span className="text-[8px] font-medium text-ds-ink-faint">{entry.subIdx + 1}</span>
                        </div>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0 pl-3`}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onRowBackgroundClick(r.id) }}
                          className="group flex min-w-0 flex-col items-start text-left"
                          title="Open item spec drawer"
                        >
                          <span className="line-clamp-1 text-[12px] font-semibold text-ds-ink transition-colors group-hover:text-ds-brand">
                            {r.cartonName}
                          </span>
                          <span className="text-[9px] text-ds-ink-faint">{r.po.poNumber}</span>
                        </button>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <span className="text-[11px] text-ds-ink-muted">{r.cartonSize ?? '—'}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0 text-center`}>
                        <span className="text-[12px] font-semibold tabular-nums text-ds-ink">{r.quantity.toLocaleString('en-IN')}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <span className="text-[11px] text-ds-ink-muted">{brd}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <span className="text-[11px] text-ds-ink-muted">{designerLabelSub || '—'}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <div className="flex flex-col gap-0.5">
                          {upsNum != null && (
                            <span className="text-[10px] font-medium text-ds-brand">×{upsNum} ups</span>
                          )}
                        </div>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0 text-right`}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onRowBackgroundClick(r.id) }}
                          className="rounded border border-ds-line/50 px-1.5 py-px text-[9px] text-ds-ink-muted hover:border-ds-brand/40 hover:text-ds-brand transition-colors"
                        >
                          Spec ↗
                        </button>
                      </td>
                    </tr>
                  </Fragment>
                )
              }

              // ── SINGLE ROW ──────────────────────────────────────────────
              // entry.kind === 'single'
              const r = entry.row
              const idx = entry.pIdx
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
              const pm = readPlanningMeta(spec)
              const rowSel = !processed && planningSelection.has(r.id)
              const batchGroupKey = batchKeyForLine(r.id, planCore)
              const batchGroup = groupByKey.get(batchGroupKey)
              const batchLineIds = batchGroup?.lineIds ?? [r.id]
              const batchIdLabel = hasBatch ? (planCore.masterSetId ?? '').trim() || '—' : null
              const batchLines = linesForBatchGroup(batchGroup, rows)
              const batchItemCount = hasBatch ? batchLines.length : 1
              const batchType = getBatchType(hasBatch ? batchLines : [r])
              const batchTypeClass = batchType === 'MIXED' ? 'text-ds-warning' : 'text-ds-success'
              const designerLabel = designerHandoffLabel(spec, planCore)
              const designerKey = resolveDesignerKey(spec, planCore)
              const upsNum = typeof pm.ups === 'number' && Number.isFinite(pm.ups) && pm.ups >= 1 ? pm.ups : null
              const upsFinal = upsNum != null
              const recallHighlight = highlightedRowId === r.id
              const pushedInPending =
                ledgerView === 'pending' &&
                recentlyPushedIds.has(r.id) &&
                r.planningStatus !== 'pending'
              const pushedTimeLabel = pushedInPending
                ? timeAgoShort(
                    ((r.specOverrides || {}) as Record<string, unknown>).planningMakeProcessingAt ??
                      ((r.specOverrides || {}) as Record<string, unknown>).awQueueHandoffAt,
                  )
                : null
              const rowActionFeedback = actionFeedbackByLineId[r.id]
              const prev = idx > 0 ? sorted[idx - 1] : null
              const prevSpec = prev ? ((prev.specOverrides || {}) as Record<string, unknown>) : null
              const prevCore = prevSpec ? readPlanningCore(prevSpec) : null
              const prevBatchKey = prev && prevCore ? batchKeyForLine(prev.id, prevCore) : null
              const sameBatchAsPrev = prevBatchKey != null && prevBatchKey === batchGroupKey
              const isNewBatch = idx === 0 || !sameBatchAsPrev
              const isReadyForArtwork = !!designerLabel && upsFinal

              return (
                <Fragment key={r.id}>
                  <tr
                    className={`${dataTable.tr.body} ${dataTable.tr.hover} ${
                      recallHighlight
                        ? 'bg-ds-success/15 ring-1 ring-inset ring-ds-success/35'
                        : pushedInPending
                          ? 'bg-ds-success/12'
                        : rowSel
                          ? dataTable.tr.selected
                          : sameBatchAsPrev
                            ? 'bg-ds-card/20'
                          : idx % 2 === 0
                            ? 'bg-ds-main/20'
                            : 'bg-ds-elevated/15'
                    } ${isNewBatch ? 'border-t border-ds-line' : ''}`}
                  >
                    <td
                      className={`${dataTable.th} sticky left-0 z-10 w-10 min-w-0 max-w-10 border-b border-ds-line/30 border-r border-ds-line/50 px-0 text-center ${
                        recallHighlight
                          ? 'bg-ds-success/15'
                          : pushedInPending
                            ? 'bg-ds-success/12'
                            : 'bg-ds-elevated'
                      }`}
                    >
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-[10px] font-bold text-ds-ink-faint">{idx + 1}</span>
                        {processed ? (
                          <button
                            type="button"
                            title="Recall from AW — returns line to pending planning"
                            className={`${ICON_BUTTON_BASE} h-7 w-7 rounded-ds-sm border border-ds-success/40 bg-ds-success/10 text-ds-ink duration-200 hover:border-ds-success/60 hover:bg-ds-success/15`}
                            onClick={(e) => {
                              e.stopPropagation()
                              void onRecallLine(r.id)
                            }}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-ds-brand"
                            checked={planningSelection.has(r.id)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => {
                              setPlanningSelection((prev) => {
                                const next = new Set(prev)
                                if (next.has(r.id)) next.delete(r.id)
                                else next.add(r.id)
                                return next
                              })
                            }}
                            aria-label="Select row for group"
                          />
                        )}
                      </div>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      {/* DC-style: name bold + PO·customer below */}
                      <button
                        type="button"
                        className="group flex min-w-0 flex-col items-start text-left"
                        onClick={(e) => {
                          e.stopPropagation()
                          onRowBackgroundClick(r.id)
                        }}
                        title="Open product spec drawer"
                      >
                        <span className="line-clamp-1 text-[13px] font-semibold text-ds-ink group-hover:text-ds-brand transition-colors">
                          {r.cartonName}
                        </span>
                        <span className="text-[10px] text-ds-ink-faint">
                          {r.po.poNumber} · {r.po.customer.name}
                        </span>
                      </button>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <button
                        type="button"
                        className="text-left text-[12px] text-ds-ink-muted hover:text-ds-brand transition-colors"
                        onClick={(e) => {
                          e.stopPropagation()
                          onRowBackgroundClick(r.id)
                        }}
                        title="Open product spec drawer"
                      >
                        {r.cartonSize ?? '—'}
                      </button>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <input
                        type="number"
                        min={1}
                        className={inp + ' text-center text-[13px] font-semibold text-ds-ink tabular-nums'}
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
                        className="truncate text-[12px] font-medium text-ds-ink-muted"
                        title={brd}
                      >
                        {brd}
                      </p>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <select
                        className={inp + ' py-0 text-[12px]'}
                        disabled={processed}
                        value={designerKey}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const key = e.target.value as PlanningDesignerKey | ''
                          const prevMeta = readPlanningMeta(spec)
                          const named = key ? PLANNING_DESIGNERS[key] : null
                          const withMeta = mergePlanningMetaDesigner(spec, named)
                          const nextCore = { ...planCore, designerKey: key || null }
                          const nextSpec: Record<string, unknown> = {
                            ...withMeta,
                            planningCore: nextCore,
                          }
                          if (named) nextSpec.planningDesignerDisplayName = named
                          else delete nextSpec.planningDesignerDisplayName
                          if (Object.keys(prevMeta).length === 0 && !named) delete nextSpec.meta
                          updateRow(r.id, { specOverrides: nextSpec })
                          void onSaveLine(r.id, { specOverrides: nextSpec })
                        }}
                      >
                        <option value="">Select</option>
                        {(Object.keys(PLANNING_DESIGNERS) as PlanningDesignerKey[]).map((k) => (
                          <option key={k} value={k}>
                            {PLANNING_DESIGNERS[k]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <select
                        className={inp + ' py-0 text-[12px]'}
                        disabled={processed}
                        value={planCore.layoutType === 'gang' ? 'batch' : 'single'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const mode = e.target.value === 'batch' ? 'gang' : 'single'
                          const nextCore =
                            mode === 'single'
                              ? {
                                  ...planCore,
                                  layoutType: 'single' as const,
                                  masterSetId: null,
                                  mixSetMemberIds: null,
                                  batchStatus: 'draft' as const,
                                }
                              : {
                                  ...planCore,
                                  layoutType: 'gang' as const,
                                }
                          const nextSpec: Record<string, unknown> = { ...spec, planningCore: nextCore }
                          updateRow(r.id, { specOverrides: nextSpec })
                          void onSaveLine(r.id, { specOverrides: nextSpec })
                        }}
                      >
                        <option value="single">Single</option>
                        <option value="batch">Group</option>
                      </select>
                    </td>
                    <td className={`${cellBase} min-w-0 align-middle overflow-visible`}>
                      {/* ── DC-style compact action cell ── */}
                      <div className="flex min-w-0 flex-col items-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                        {/* Row 1: status badge · type · PO · quick meta */}
                        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
                          <span className={`${STATUS_CHIP_BASE} shrink-0 ${BATCH_STATUS_BADGE_CLASS[bStatus]}`}>
                            {BATCH_STATUS_LABEL[bStatus]}
                          </span>
                          <span className={`text-[9px] font-medium ${batchTypeClass}`}>
                            {batchItemCount} items · {batchType === 'MIXED' ? 'Mix' : 'Std'}
                          </span>
                          <span className="text-[9px] text-ds-ink-faint">
                            {batchIdLabel ? batchIdLabel.slice(0, 10) : 'Single'} · {r.po.poNumber}
                          </span>
                          {designerLabel ? (
                            <span className="text-[9px] text-ds-ink-muted" title={designerLabel}>
                              {designerLabel.split(' ')[0]}
                            </span>
                          ) : null}
                          {upsFinal ? (
                            <span
                              id={`show-ups-row-${r.id}`}
                              data-final-decision="ups"
                              className="shrink-0 text-[9px] font-medium tabular-nums text-ds-brand"
                            >
                              ×{upsNum}
                            </span>
                          ) : null}
                          {isReadyForArtwork ? (
                            <span className="text-[9px] font-semibold text-ds-success">✓ AW ready</span>
                          ) : null}
                          {pushedTimeLabel ? (
                            <span className={PUSHED_CHIP_CLASS}>
                              Pushed {pushedTimeLabel}
                            </span>
                          ) : null}
                          {rowActionFeedback ? (
                            <span
                              className={`rounded px-1 py-px text-[9px] font-medium ${
                                rowActionFeedback.ok
                                  ? 'bg-ds-success/10 text-ds-success'
                                  : 'bg-ds-warning/10 text-ds-warning'
                              }`}
                            >
                              {rowActionFeedback.text}
                            </span>
                          ) : null}
                        </div>
                        {/* Row 2: action buttons — nowrap, scrollable if needed */}
                        {renderBatchDecisionControls(batchLineIds, batchGroupKey, 'row')}
                      </div>
                    </td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
        {sorted.length === 0 ? <p className={dataTable.empty}>No lines in this view.</p> : null}
      </div>

      {/* ── Pagination bar ── */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-ds-line/50 bg-ds-elevated/30 px-4 py-2.5 text-[12px] text-ds-ink-muted">
        {/* Left: rows-per-page selector */}
        <div className="flex items-center gap-2">
          <span className="text-ds-ink-faint">Rows per page:</span>
          {([25, 50, 100] as const).map((n) => (
            <button
              key={n}
              onClick={() => { setPageSize(n); setPage(0) }}
              className={`rounded px-2 py-0.5 font-medium transition-colors duration-150 ${
                pageSize === n
                  ? 'bg-ds-brand text-white'
                  : 'text-ds-ink hover:bg-ds-elevated hover:text-ds-ink'
              }`}
            >
              {n}
            </button>
          ))}
        </div>

        {/* Centre: count */}
        <span className="tabular-nums text-ds-ink-muted">
          {sorted.length === 0
            ? 'No lines'
            : `${pageStart}–${pageEnd} of ${sorted.length} line${sorted.length !== 1 ? 's' : ''}`}
        </span>

        {/* Right: prev / next */}
        <div className="flex items-center gap-1">
          <button
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded px-2.5 py-1 font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-30 hover:bg-ds-elevated hover:text-ds-ink"
          >
            ← Prev
          </button>
          <span className="px-2 tabular-nums">
            {safePage + 1} / {totalPages}
          </span>
          <button
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="rounded px-2.5 py-1 font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-30 hover:bg-ds-elevated hover:text-ds-ink"
          >
            Next →
          </button>
        </div>
      </div>
    </DataTableFrame>
  )
}
