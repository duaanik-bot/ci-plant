'use client'

import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Layers, RotateCcw, Trash2 } from 'lucide-react'
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
import { formatShortTimeAgo } from '@/lib/time-ago'
import { ACTION_PILL_BASE, ICON_BUTTON_BASE, PUSHED_CHIP_CLASS, STATUS_CHIP_BASE } from '@/components/design-system/tokens'
import { dataTable, DataTableFrame } from '@/components/design-system/DataTable'
import { useUiDensity } from '@/lib/ui-density'

const cellBase = `align-middle border-b border-ds-line/30 text-sm text-ds-ink min-h-[40px] px-2 py-2`
const filterGhost = dataTable.filter.input

const inp =
  'h-8 w-full min-w-0 rounded-ds-sm border border-ds-line bg-ds-elevated/90 px-2 text-sm text-ds-ink tabular-nums transition-[border-color,box-shadow] duration-150 ease-out disabled:opacity-50 focus:border-ds-brand focus:outline-none focus:shadow-ds-focus'

const batchActionSelect =
  'h-9 min-w-[8rem] rounded-full border border-ds-line/60 bg-ds-elevated px-2 text-xs leading-5 font-medium text-ds-ink placeholder:text-ds-ink-faint outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30'
const batchActionApply =
  `${ACTION_PILL_BASE} h-9 min-w-0 rounded-full border-ds-brand/40 bg-ds-brand/15 px-2 py-1 text-xs text-ds-ink hover:bg-ds-brand/25 disabled:cursor-not-allowed`

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

function gsmLabel(r: PlanningGridLine): string {
  const raw = r.gsm ?? r.carton?.gsm ?? null
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return `${Math.round(n)} GSM`
}

function coatingLabel(r: PlanningGridLine): string {
  const explicit = typeof r.otherCoating === 'string' ? r.otherCoating.trim() : ''
  if (explicit) return explicit
  const primary = typeof r.coatingType === 'string' ? r.coatingType.trim() : ''
  if (primary) return primary
  const cartonCoating = typeof r.carton?.coatingType === 'string' ? r.carton.coatingType.trim() : ''
  if (cartonCoating) return cartonCoating
  const cartonLamination = typeof r.carton?.laminateType === 'string' ? r.carton.laminateType.trim() : ''
  if (cartonLamination) return cartonLamination
  return '—'
}

type SortKey = 'cartonName' | 'cartonSize' | 'qty' | 'board' | 'gsm' | 'coating' | 'batch'

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
        if (cmp === 0) {
          cmp = gsmLabel(a).localeCompare(gsmLabel(b), undefined, { numeric: true })
        }
        if (cmp === 0) {
          cmp = coatingLabel(a).localeCompare(coatingLabel(b))
        }
        if (cmp === 0) {
          cmp = a.cartonName.localeCompare(b.cartonName)
        }
        break
      case 'gsm':
        cmp = gsmLabel(a).localeCompare(gsmLabel(b), undefined, { numeric: true })
        break
      case 'coating':
        cmp = coatingLabel(a).localeCompare(coatingLabel(b))
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
  onDeleteLine,
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
  onDeleteLine: (lineId: string) => Promise<void>
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
  const [fGsm, setFGsm] = useState('')
  const [fCoating, setFCoating] = useState('')
  const [fBatch, setFBatch] = useState('')
  const [holdOpenKey, setHoldOpenKey] = useState<string | null>(null)
  const [holdReason, setHoldReason] = useState('')
  const [bulkHoldOpen, setBulkHoldOpen] = useState(false)
  const [bulkHoldReason, setBulkHoldReason] = useState('')
  const [actionChoiceByKey, setActionChoiceByKey] = useState<Record<string, PlanningBatchDecisionAction | ''>>({})
  const [actionFeedbackByLineId, setActionFeedbackByLineId] = useState<
    Record<string, { ok: boolean; text: string }>
  >({})
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [rowDensity] = useUiDensity()
  const [showColumnFilters, setShowColumnFilters] = useState(false)

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
      if (fGsm.trim() && !match(gsmLabel(r), fGsm)) return false
      if (fCoating.trim() && !match(coatingLabel(r), fCoating)) return false
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
  }, [viewRows, fCarton, fSize, fQty, fBoard, fGsm, fCoating, fBatch])

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
  const prevFiltersRef = useRef({
    fCarton, fSize, fQty, fBoard, fGsm, fCoating, fBatch, ledgerView, sortKey, sortDir,
  })
  useEffect(() => {
    const prev = prevFiltersRef.current
    if (
      prev.fCarton !== fCarton || prev.fSize !== fSize || prev.fQty !== fQty ||
      prev.fBoard !== fBoard || prev.fGsm !== fGsm || prev.fCoating !== fCoating ||
      prev.fBatch !== fBatch || prev.ledgerView !== ledgerView ||
      prev.sortKey !== sortKey || prev.sortDir !== sortDir
    ) {
      setPage(0)
      prevFiltersRef.current = {
        fCarton, fSize, fQty, fBoard, fGsm, fCoating, fBatch, ledgerView, sortKey, sortDir,
      }
    }
  }, [fCarton, fSize, fQty, fBoard, fGsm, fCoating, fBatch, ledgerView, sortKey, sortDir])

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
    const canHold = applyBatchDecisionAction(core, 'hold_batch') != null
    const canSend = applyBatchDecisionAction(core, 'send_to_artwork') != null
    const canRelease = applyBatchDecisionAction(core, 'release_to_production') != null
    const canResume = applyBatchDecisionAction(core, 'resume_from_hold') != null
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
        const successSnapshots: Array<{
          id: string
          planningStatus: string
          specOverrides: Record<string, unknown>
        }> = []
        for (const id of lineIds) {
          warnIfMissingHandoff(id)
          const ok = (await onBatchDecision([id], action, holdReasonArg, { suppressToast: true })) !== false
          if (ok) successCount += 1
          else failCount += 1
          if (ok) {
            const snap = undoSnapshots.find((s) => s.id === id)
            if (snap) successSnapshots.push(snap)
          }
          setActionFeedback(id, ok, ok ? `✓ ${actionLabel(action)}` : `✕ ${actionLabel(action)}`)
        }
        toast.success(`${successCount} updated${failCount ? ` • ${failCount} failed` : ''}`)
        if (successCount > 0) showPermanentUndo(successSnapshots, actionLabel(action))
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
      if (ok) showPermanentUndo(undoSnapshots, actionLabel(action))
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
    const actionKey = mode === 'row' ? groupKey : `bulk:${groupKey}`
    const selectedAction = actionChoiceByKey[actionKey] ?? ''
    const actionOptions: Array<{ value: PlanningBatchDecisionAction; label: string; enabled: boolean }> = [
      { value: 'approve_batch', label: 'Approve', enabled: canApprove },
      { value: 'hold_batch', label: 'Hold', enabled: canHold },
      { value: 'send_to_artwork', label: 'To Artwork', enabled: canSend },
      { value: 'release_to_production', label: 'To Production', enabled: canRelease },
      { value: 'resume_from_hold', label: 'Resume', enabled: canResume },
    ]
    const undoSnapshots = lineIds
      .map((id) => {
        const row = rows.find((r) => r.id === id)
        if (!row) return null
        return {
          id: row.id,
          planningStatus: row.planningStatus,
          specOverrides: (row.specOverrides || {}) as Record<string, unknown>,
        }
      })
      .filter((snap): snap is { id: string; planningStatus: string; specOverrides: Record<string, unknown> } => !!snap)

    const restoreSnapshots = async (
      snaps: Array<{ id: string; planningStatus: string; specOverrides: Record<string, unknown> }>,
    ) => {
      let ok = 0
      for (const snap of snaps) {
        try {
          const res = await fetch(`/api/planning/po-lines/${snap.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              planningStatus: snap.planningStatus,
              specOverrides: snap.specOverrides,
              planningDecisionRevision: true,
            }),
          })
          if (!res.ok) throw new Error('restore failed')
          updateRow(snap.id, { planningStatus: snap.planningStatus, specOverrides: snap.specOverrides })
          ok += 1
        } catch {
          // Aggregate error toast below.
        }
      }
      if (ok === snaps.length) toast.success('Undo applied')
      else toast.error(`Undo partial: ${ok}/${snaps.length}`)
    }

    const showPermanentUndo = (
      snaps: Array<{ id: string; planningStatus: string; specOverrides: Record<string, unknown> }>,
      label: string,
    ) => {
      if (!snaps.length) return
      toast.message(`Done: ${label}`, {
        duration: 5000,
        action: {
          label: 'Undo',
          onClick: () => void restoreSnapshots(snaps),
        },
      })
    }

    return (
      <div
        data-batch-actions
        id="fix-action-layout"
        className="flex min-w-0 flex-col items-start gap-0.5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          const target = e.target as HTMLElement
          const tag = target.tagName
          if (
            tag === 'INPUT' ||
            tag === 'SELECT' ||
            tag === 'TEXTAREA' ||
            tag === 'BUTTON' ||
            target.isContentEditable
          ) {
            return
          }
          const key = e.key.toLowerCase()
          if (!['a', 'h', 'w', 'p'].includes(key)) return
          e.preventDefault()
          if (key === 'a') void runAction('approve_batch')
          if (key === 'h') openHold()
          if (key === 'w') void runAction('send_to_artwork')
          if (key === 'p') void runAction('release_to_production')
        }}
      >
        {mode === 'row' && onHold && core.batchHoldReason ? (
          <p
            className="order-first max-w-full text-left text-xs leading-tight text-rose-700/90 dark:text-rose-200/90 line-clamp-1"
            title={core.batchHoldReason}
          >
            <span className="font-semibold text-rose-300/95">Hold:</span> {core.batchHoldReason}
          </p>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center justify-start gap-1">
          <div className="inline-flex items-center gap-1 rounded-full border border-ds-line/50 bg-ds-main/40 p-1">
            <select
              value={selectedAction}
              onChange={(e) =>
                setActionChoiceByKey((prev) => ({
                  ...prev,
                  [actionKey]: e.target.value as PlanningBatchDecisionAction | '',
                }))
              }
              onClick={(e) => e.stopPropagation()}
              className={batchActionSelect}
              title={mode === 'bulk' ? bulkTitle : rowTitleApprove}
            >
              <option value="">Select action…</option>
              {actionOptions.map((opt) => (
                <option key={opt.value} value={opt.value} disabled={!opt.enabled}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={batchActionBusy || !selectedAction}
              className={batchActionApply}
              onClick={(e) => {
                e.stopPropagation()
                if (!selectedAction) return
                if (selectedAction === 'hold_batch') {
                  openHold()
                  return
                }
                void runAction(selectedAction)
              }}
            >
              Apply
            </button>
          </div>
        </div>
        {holdIsOpen ? (
          <span className="flex w-full min-w-0 flex-nowrap items-center justify-start gap-1">
            <input
              className="min-w-0 max-w-[10rem] flex-1 rounded border border-ds-warning/30 bg-ds-main px-1.5 py-px text-xs text-ds-ink"
              placeholder="Reason required"
              value={reasonVal}
              onChange={(e) => setReasonVal(e.target.value)}
            />
            <button
              type="button"
              disabled={batchActionBusy}
              className="shrink-0 rounded bg-rose-800 px-1.5 py-px text-xs text-white"
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
        <div className="shrink-0 border-b border-ds-warning/25 bg-ds-warning/10 px-3 py-2 text-xs text-ds-ink">
          {mixAdvisoryNote}
        </div>
      ) : null}
      {mixConflictMessage ? (
        <div
          className={`shrink-0 px-3 py-2 text-xs ${
            flash ? 'bg-ds-error/20 text-ds-ink animate-pulse' : 'bg-ds-error/10 text-ds-ink-muted'
          }`}
        >
          {mixConflictMessage}
        </div>
      ) : null}

      {planningSelection.size > 1 ? (
        <div
          id="fix-bulk-bar"
          className="shrink-0 border-b border-ds-line/50 bg-ds-elevated/35 px-2 py-2"
          data-batch-actions
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 pt-0.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
                Group actions · {planningSelection.size} selected
                <span className="ml-1.5 font-normal normal-case text-ds-ink-muted">
                  (one run per row)
                </span>
              </p>
              {bulkSpansMultipleBatches ? (
                <p className="mt-0.5 text-xs font-normal normal-case text-ds-warning">
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

      <div className={`${dataTable.wrap} overflow-x-auto`}>
        <div className="shrink-0 border-y border-ds-line/30 bg-ds-elevated/25 px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <button
              type="button"
              onClick={() => setShowColumnFilters((v) => !v)}
              className={`rounded-full px-2 py-0.5 ${
                showColumnFilters ? 'bg-ds-brand/20 text-ds-ink' : 'text-ds-ink-muted hover:text-ds-ink'
              }`}
            >
              {showColumnFilters ? 'Hide filters' : 'Show filters'}
            </button>
            <div className="text-ds-ink-faint">
              Density: {rowDensity === 'dense' ? 'Dense' : 'Comfortable'}
            </div>
          </div>
        </div>
        <table
          className={`${dataTable.table} ${
            rowDensity === 'dense' ? '[&_tbody_td]:py-1 [&_thead_th]:py-1.5 [&_tbody_td]:leading-tight' : ''
          } [&_thead_th]:align-middle [&_tbody_td]:align-middle [&_thead_th]:text-left`}
        >
          <thead className={dataTable.thead}>
            <tr>
              <th
                className={`${dataTable.th} ${dataTable.thSticky} min-h-[32px] w-10 min-w-0 max-w-10 bg-ds-elevated px-0 py-2 text-center text-xs text-ds-ink-faint`}
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
                      className="rounded border border-ds-brand/35 bg-ds-brand/10 px-1 py-0 text-xs font-medium text-ds-brand"
                      title={`${planningSelection.size} selected`}
                    >
                      {planningSelection.size}
                    </span>
                  ) : null}
                </div>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[22%] min-w-0 py-2`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('cartonName')}>
                  Carton {sortKey === 'cartonName' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[9%] min-w-0 py-2`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('cartonSize')}>
                  Size {sortKey === 'cartonSize' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[8%] min-w-0 py-2 text-center`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('qty')}>
                  Qty {sortKey === 'qty' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[9%] min-w-0 py-2`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('board')}>
                  Board {sortKey === 'board' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[8%] min-w-0 py-2`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('gsm')}>
                  GSM {sortKey === 'gsm' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[10%] min-w-0 py-2`}>
                <button type="button" className={dataTable.thSortBtn} onClick={() => toggleSort('coating')}>
                  Coating {sortKey === 'coating' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
              <th className={`${dataTable.th} min-h-[32px] w-[10%] min-w-0 py-2`}>Designer</th>
              <th className={`${dataTable.th} min-h-[32px] w-[6%] min-w-0 py-2`}>Set type</th>
              <th className={`${dataTable.th} sticky right-0 z-20 min-h-[32px] w-[20%] min-w-0 bg-ds-elevated/95 py-2 text-left`}>
                <button
                  type="button"
                  className={`${dataTable.thSortBtn} w-full justify-start text-left`}
                  onClick={() => toggleSort('batch')}
                >
                  Group / actions {sortKey === 'batch' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </button>
              </th>
            </tr>
            {showColumnFilters ? (
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
              <th className="px-2 py-1">
                <input
                  className={filterGhost}
                  placeholder="GSM"
                  value={fGsm}
                  onChange={(e) => setFGsm(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
              <th className="px-2 py-1">
                <input
                  className={filterGhost}
                  placeholder="Coating"
                  value={fCoating}
                  onChange={(e) => setFCoating(e.target.value)}
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
            ) : null}
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
                const allGsms = Array.from(new Set(groupRows.map((r) => gsmLabel(r))))
                const gsmDisplay = allGsms.length === 1 ? allGsms[0]! : 'Mixed'
                const allCoatings = Array.from(new Set(groupRows.map((r) => coatingLabel(r))))
                const coatingDisplay = allCoatings.length === 1 ? allCoatings[0]! : 'Mixed'
                const designerLabel0 = designerHandoffLabel(spec0, planCore0)
                const isExpanded = expandedGroups.has(groupId)
                const allGroupSel = groupRows.every((r) => planningSelection.has(r.id))
                const someGroupSel = groupRows.some((r) => planningSelection.has(r.id))
                const allSizes = Array.from(new Set(groupRows.map((r) => String(r.cartonSize ?? '').trim())))
                const sizeDisplay = allSizes.length === 1 ? allSizes[0]! : 'Mixed'
                const groupProcessed = groupRows.every((r) => isProcessedRow(r))
                const groupCompleted = groupRows.every((r) => r.planningStatus !== 'pending')

                return (
                  <Fragment key={`group:${groupId}`}>
                    <tr
                      tabIndex={0}
                      onClick={() => onRowBackgroundClick(firstRow.id)}
                      className={`border-l-[3px] border-ds-brand transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ds-brand/45 ${
                        groupCompleted
                          ? 'bg-emerald-500/10 hover:bg-emerald-500/15 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/24'
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
                          <span className="text-xs font-bold text-ds-brand">{pIdx + 1}</span>
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
                            <span className="inline-flex items-center gap-0.5 rounded border border-ds-brand/40 bg-ds-brand/15 px-1 py-px text-xs font-bold text-ds-brand">
                              <Layers className="h-2.5 w-2.5" aria-hidden /> GANG · {groupRows.length} items
                            </span>
                            <span className="text-xs text-ds-ink-faint">{firstRow.po.customer.name}</span>
                          </div>
                          {groupRows.slice(0, 2).map((r) => (
                            <button
                              key={r.id}
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onRowBackgroundClick(r.id) }}
                              className={`line-clamp-2 break-words text-left text-xs font-semibold leading-tight transition-colors hover:text-ds-brand ${
                                groupCompleted ? 'text-emerald-700 dark:text-emerald-300' : 'text-ds-ink'
                              }`}
                              title={r.cartonName}
                            >
                              {r.cartonName}
                            </button>
                          ))}
                          {groupRows.length > 2 && <span className="text-xs text-ds-ink-faint">+{groupRows.length - 2} more items</span>}
                        </div>
                      </td>

                      {/* Size */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className={`text-xs ${allSizes.length > 1 ? 'text-ds-warning' : 'text-ds-ink-muted'}`}>
                          {sizeDisplay || '—'}
                        </span>
                      </td>

                      {/* Qty — combined */}
                      <td className={`${cellBase} min-w-0 text-center`}>
                        <div className="flex flex-col items-center">
                          <span className="ds-typo-kpi text-sm">
                            {totalGroupQty.toLocaleString('en-IN')}
                          </span>
                          <span className="text-xs text-ds-ink-faint">combined</span>
                        </div>
                      </td>

                      {/* Board */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className={`text-xs font-medium ${allBoards.length > 1 ? 'text-ds-warning' : 'text-ds-ink-muted'}`}>
                          {boardDisplay}
                        </span>
                      </td>

                      {/* GSM */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className={`text-xs font-medium ${allGsms.length > 1 ? 'text-ds-warning' : 'text-ds-ink-muted'}`}>
                          {gsmDisplay}
                        </span>
                      </td>

                      {/* Coating */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className={`line-clamp-2 break-words text-xs leading-tight ${allCoatings.length > 1 ? 'text-ds-warning' : 'text-ds-ink-muted'}`}>
                          {coatingDisplay}
                        </span>
                      </td>

                      {/* Designer */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className="text-xs text-ds-ink-muted">{designerLabel0 || '—'}</span>
                      </td>

                      {/* Set type */}
                      <td className={`${cellBase} min-w-0`}>
                        <span className="inline-flex items-center rounded border border-ds-brand/35 bg-ds-brand/10 px-1.5 py-px text-xs font-semibold text-ds-brand">
                          Gang
                        </span>
                      </td>

                      {/* Group actions + expand */}
                      <td className={`${cellBase} sticky right-0 z-10 min-w-0 align-middle overflow-visible border-l border-ds-line/30 bg-inherit`}>
                        <div className="w-full rounded-md border border-ds-line/35 bg-ds-card/25 p-1.5" onClick={(e) => e.stopPropagation()}>
                          <div className="mb-1 flex min-w-0 flex-wrap items-center justify-start gap-1">
                            <span className={`${STATUS_CHIP_BASE} shrink-0 ${BATCH_STATUS_BADGE_CLASS[bStatus0]}`}>
                              {BATCH_STATUS_LABEL[bStatus0]}
                            </span>
                            <span className="text-xs text-ds-ink-faint">{(planCore0.masterSetId ?? '').slice(0, 10)}</span>
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
                            className="mt-0.5 flex items-center gap-0.5 rounded border border-ds-brand/30 bg-ds-brand/8 px-1.5 py-px text-xs font-medium text-ds-brand hover:bg-ds-brand/15 transition-colors"
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
                const gsm = gsmLabel(r)
                const coating = coatingLabel(r)
                const upsNum = typeof pm.ups === 'number' && Number.isFinite(pm.ups) && pm.ups >= 1 ? pm.ups : null
                const designerLabelSub = designerHandoffLabel(spec, planCore)
                const subCompleted = r.planningStatus !== 'pending'
                return (
                  <Fragment key={`sub:${r.id}`}>
                    <tr
                      tabIndex={0}
                      onClick={() => onRowBackgroundClick(r.id)}
                      className={`border-l-[3px] border-ds-brand/40 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ds-brand/45 ${
                        subCompleted
                          ? 'bg-emerald-500/10 hover:bg-emerald-500/15 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/24'
                          : 'bg-ds-brand/3 hover:bg-ds-brand/6'
                      }`}
                    >
                      <td
                        className={`${dataTable.th} ${dataTable.thSticky} min-h-[32px] w-10 min-w-0 max-w-10 border-b border-ds-line/20 border-r border-ds-brand/20 bg-ds-brand/5 px-0 text-center`}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-xs text-ds-brand/60">↳</span>
                          <span className="text-xs font-medium text-ds-ink-faint">{entry.subIdx + 1}</span>
                        </div>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0 pl-3`}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onRowBackgroundClick(r.id) }}
                          className="group flex min-w-0 flex-col items-start text-left"
                          title="Open item spec drawer"
                        >
                          <span className={`line-clamp-2 break-words text-xs font-semibold leading-tight transition-colors group-hover:text-ds-brand ${
                            subCompleted ? 'text-emerald-700 dark:text-emerald-300' : 'text-ds-ink'
                          }`}>
                            {r.cartonName}
                          </span>
                          <span className="text-xs text-ds-ink-faint">{r.po.poNumber}</span>
                        </button>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <span className="text-xs text-ds-ink-muted">{r.cartonSize ?? '—'}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0 text-center`}>
                        <span className="text-xs font-semibold tabular-nums text-ds-ink">{r.quantity.toLocaleString('en-IN')}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <span className="text-xs text-ds-ink-muted">{brd}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <span className="text-xs text-ds-ink-muted">{gsm}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <span className="line-clamp-2 break-words text-xs leading-tight text-ds-ink-muted">{coating}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <span className="text-xs text-ds-ink-muted">{designerLabelSub || '—'}</span>
                      </td>
                      <td className={`${cellBase} border-b border-ds-line/20 min-w-0`}>
                        <div className="flex flex-col gap-0.5">
                          {upsNum != null && (
                            <span className="text-xs font-medium text-ds-brand">×{upsNum} ups</span>
                          )}
                        </div>
                      </td>
                      <td className={`${cellBase} sticky right-0 z-10 min-w-0 border-b border-ds-line/20 border-l border-ds-line/30 bg-inherit text-left`}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onRowBackgroundClick(r.id) }}
                          className="rounded border border-ds-line/50 px-1.5 py-px text-xs text-ds-ink-muted hover:border-ds-brand/40 hover:text-ds-brand transition-colors"
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
              const gsm = gsmLabel(r)
              const coating = coatingLabel(r)
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
              const completedRow = r.planningStatus !== 'pending'
              const pushedTimeLabel = completedRow
                ? formatShortTimeAgo(
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
                    tabIndex={0}
                    onClick={() => onRowBackgroundClick(r.id)}
                    className={`${dataTable.tr.body} ${dataTable.tr.hover} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ds-brand/45 ${
                      recallHighlight
                        ? 'bg-ds-success/15 ring-1 ring-inset ring-ds-success/35'
                        : completedRow
                          ? 'bg-emerald-500/10 hover:bg-emerald-500/15 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/24'
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
                          : completedRow
                            ? 'bg-emerald-500/10 hover:bg-emerald-500/15 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/24'
                            : 'bg-ds-elevated'
                      }`}
                    >
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-xs font-bold text-ds-ink-faint">{idx + 1}</span>
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
                          <>
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
                            <button
                              type="button"
                              title="Delete line"
                              className={`${ICON_BUTTON_BASE} h-6 w-6 rounded-ds-sm border border-rose-500/35 bg-rose-500/10 text-rose-700 duration-200 hover:border-rose-500/60 hover:bg-rose-500/15 dark:text-rose-300`}
                              onClick={(e) => {
                                e.stopPropagation()
                                void onDeleteLine(r.id)
                              }}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </>
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
                        <span className={`line-clamp-2 break-words text-sm font-semibold leading-tight group-hover:text-ds-brand transition-colors ${
                          completedRow ? 'text-emerald-700 dark:text-emerald-300' : 'text-ds-ink'
                        }`}>
                          {r.cartonName}
                        </span>
                        <span className="text-xs text-ds-ink-faint">
                          {r.po.poNumber} · {r.po.customer.name}
                        </span>
                      </button>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <button
                        type="button"
                        className="text-left text-xs text-ds-ink-muted hover:text-ds-brand transition-colors"
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
                        className={inp + ' text-center text-sm font-semibold text-ds-ink tabular-nums'}
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
                      <p className="line-clamp-2 break-words text-xs font-medium leading-tight text-ds-ink-muted" title={brd}>
                        {brd}
                      </p>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <p className="truncate text-xs font-medium text-ds-ink-muted" title={gsm}>
                        {gsm}
                      </p>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <p className="line-clamp-2 break-words text-xs font-medium leading-tight text-ds-ink-muted" title={coating}>
                        {coating}
                      </p>
                    </td>
                    <td className={`${cellBase} min-w-0`}>
                      <select
                        className={inp + ' py-0 text-xs'}
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
                        className={inp + ' py-0 text-xs'}
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
                    <td className={`${cellBase} sticky right-0 z-10 min-w-0 align-middle overflow-visible border-l border-ds-line/30 bg-inherit`}>
                      {/* ── DC-style compact action cell ── */}
                      <div className="w-full rounded-md border border-ds-line/35 bg-ds-card/25 p-1.5" onClick={(e) => e.stopPropagation()}>
                        <div className="mb-1 flex min-w-0 flex-wrap items-center justify-start gap-1">
                          <span className={`${STATUS_CHIP_BASE} shrink-0 ${BATCH_STATUS_BADGE_CLASS[bStatus]}`}>
                            {BATCH_STATUS_LABEL[bStatus]}
                          </span>
                          <span className="text-xs text-ds-ink-faint">{batchIdLabel ? batchIdLabel.slice(0, 10) : 'Single'}</span>
                          <span className={`text-xs font-medium ${batchTypeClass}`}>{batchType === 'MIXED' ? 'Mix' : 'Std'}</span>
                          {isReadyForArtwork ? (
                            <span className="text-xs font-semibold text-ds-success">✓ AW ready</span>
                          ) : null}
                          {pushedTimeLabel ? (
                            <span className={PUSHED_CHIP_CLASS}>
                              Pushed {pushedTimeLabel}
                            </span>
                          ) : null}
                          {rowActionFeedback ? (
                            <span
                              className={`rounded px-1 py-px text-xs font-medium ${
                                rowActionFeedback.ok
                                  ? 'bg-ds-success/10 text-ds-success'
                                  : 'bg-ds-warning/10 text-ds-warning'
                              }`}
                            >
                              {rowActionFeedback.text}
                            </span>
                          ) : null}
                        </div>
                        {renderBatchDecisionControls(batchLineIds, batchGroupKey, 'row')}
                      </div>
                    </td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
        {sorted.length === 0 ? (
          <p className={dataTable.empty}>No rows match current view or filters. Clear filters to see all rows.</p>
        ) : null}
      </div>

      {/* ── Pagination bar ── */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-ds-line/50 bg-ds-elevated/30 px-4 py-2 text-xs text-ds-ink-muted">
        {/* Left: rows-per-page selector */}
        <div className="flex items-center gap-2">
          <span className="text-ds-ink-faint">Rows per page:</span>
          {([25, 50, 100] as const).map((n) => (
            <button
              key={n}
              onClick={() => { setPageSize(n); setPage(0) }}
              className={`rounded px-2 py-1 font-medium transition-colors duration-150 ${
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
