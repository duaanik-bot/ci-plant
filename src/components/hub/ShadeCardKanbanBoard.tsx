'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { AnimatePresence, motion } from 'framer-motion'
import { GripVertical, Star } from 'lucide-react'
import { HubCardDeleteAction } from '@/components/hub/HubCardDeleteAction'
import { toast } from 'sonner'
import { shadeCardAgeTier, type ShadeCardAgeTier } from '@/lib/shade-card-age'
import {
  type ShadeKanbanColumnId,
  kanbanLocationCode,
  shadeCardAgeLifecyclePercent,
  shadeCardKanbanColumn,
} from '@/lib/shade-card-kanban'
import { shadeCardDnaColor } from '@/lib/lab-to-rgb'
import {
  INDUSTRIAL_PRIORITY_ROW_CLASS,
  INDUSTRIAL_PRIORITY_STAR_ICON_CLASS,
} from '@/lib/industrial-priority-ui'
import { SHADE_MASTER_RACK_LOCATION } from '@/lib/inventory-hub-custody'
import { HubPriorityController, HubPriorityRankBadge } from '@/components/hub/HubPriorityController'
import { HubPriorityReorderAuditFooter } from '@/components/hub/HubPriorityReorderAuditFooter'
import type { HubPriorityDomain } from '@/lib/hub-priority-domain'
import { shadeCardPhysicalLabel } from '@/lib/shade-card-custody-condition'
import { safeJsonParse, safeJsonParseArray, safeJsonStringify } from '@/lib/safe-json'
import type { ShadeCardSpotlightRow } from '@/components/hub/ShadeCardSpotlightDrawer'

const DROP_IN_STOCK = 'kanban-drop-in-stock'
const DROP_ON_FLOOR = 'kanban-drop-on-floor'
const SHADE_ISSUE_OPERATOR_KEY = 'shade-hub-issue-operator'
const SHADE_RECEIVE_OPERATOR_KEY = 'shade-hub-receive-operator'

const SHADE_HUB_MAX_ORDER = Number.MAX_SAFE_INTEGER

function shadeHubDomain(col: ShadeKanbanColumnId): HubPriorityDomain {
  if (col === 'in_stock') return 'shade_in_stock'
  if (col === 'on_floor') return 'shade_on_floor'
  if (col === 'reverify') return 'shade_reverify'
  return 'shade_expired'
}

function shadeOrderValue(row: ShadeCardSpotlightRow, col: ShadeKanbanColumnId): number {
  const v =
    col === 'in_stock'
      ? row.hubOrderInStock
      : col === 'on_floor'
        ? row.hubOrderOnFloor
        : col === 'reverify'
          ? row.hubOrderReverify
          : row.hubOrderExpired
  return v ?? SHADE_HUB_MAX_ORDER
}

const COLS: { id: ShadeKanbanColumnId; title: string; dropId?: string }[] = [
  { id: 'in_stock', title: 'In-Stock', dropId: DROP_IN_STOCK },
  { id: 'on_floor', title: 'On-Floor', dropId: DROP_ON_FLOOR },
  { id: 'reverify', title: 'Re-Verify (9m+)' },
  { id: 'expired', title: 'Expired (12m+)' },
]

type MachineOpt = { id: string; machineCode: string; name: string }
type UserOpt = { id: string; name: string }
type JobCardHit = { id: string; jobCardNumber: number; status: string; customer: { name: string } }

function AgeRing({ pct, monoClass, tier }: { pct: number; monoClass: string; tier: ShadeCardAgeTier }) {
  const r = 15
  const c = 2 * Math.PI * r
  const dash = (pct / 100) * c
  const stroke =
    tier === 'expired' ? 'text-rose-500' : tier === 'reverify' ? 'text-ds-warning' : 'text-emerald-500'
  return (
    <div className={`relative h-9 w-9 shrink-0 ${monoClass}`} title={`${pct.toFixed(0)}% of 12-mo lifecycle`}>
      <svg width="36" height="36" viewBox="0 0 36 36" className="-rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(63,63,70,0.9)" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeDasharray={`${dash} ${c}`}
          className={stroke}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-neutral-400">
        {pct.toFixed(0)}%
      </span>
    </div>
  )
}

function KanbanCardInner({
  row,
  monoClass,
  isOverlay,
  priorityRank,
}: {
  row: ShadeCardSpotlightRow
  monoClass: string
  isOverlay?: boolean
  priorityRank?: number
}) {
  const months = row.currentAgeMonths ?? null
  const tier = shadeCardAgeTier(months)
  const pct = shadeCardAgeLifecyclePercent(months)
  const clientName = row.product?.customer?.name?.trim() || row.customer?.name?.trim() || '—'
  const productName = row.product?.cartonName?.trim() || row.productMaster?.trim() || '—'
  const dna = shadeCardDnaColor({
    labL: row.labL,
    labA: row.labA,
    labB: row.labB,
    colorSwatchHex: row.colorSwatchHex,
  })
  const loc = kanbanLocationCode(row)
  const amberGlow = tier === 'reverify'

  return (
    <div
      className={`rounded-xl border bg-ds-main/90 p-2.5 shadow-lg transition-shadow ${
        amberGlow
          ? 'border-ds-warning/60 shadow-[0_0_14px_rgba(245,158,11,0.25)] animate-pulse'
          : 'border-ds-line/40'
      } ${isOverlay ? 'ring-2 ring-ds-warning/40 scale-[1.02]' : ''} ${
        row.industrialPriority ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''
      }`}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="text-xs font-bold text-emerald-400 truncate leading-tight font-sans">{clientName}</p>
        <div className="flex items-center gap-1 shrink-0">
          {row.industrialPriority ? (
            <Star
              className={`h-3.5 w-3.5 shrink-0 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`}
              aria-label="Priority"
            />
          ) : null}
          {priorityRank != null && priorityRank > 0 ? <HubPriorityRankBadge rank={priorityRank} /> : null}
        </div>
      </div>
      <p className="mt-1 text-base font-medium text-foreground leading-snug line-clamp-2 font-sans">{productName}</p>
      <div
        className="mt-2 h-14 w-full rounded-md border border-ds-line/40 shadow-inner"
        style={{ backgroundColor: dna }}
        title="L*a*b* DNA"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <AgeRing pct={pct} monoClass={monoClass} tier={tier} />
        <div className={`text-xs text-neutral-500 text-right leading-tight ${monoClass}`}>
          {months != null ? `${months.toFixed(2)} mo` : '—'}
        </div>
      </div>
      <div className={`mt-2 flex items-center justify-between gap-2 border-t border-ds-line/50 pt-2 ${monoClass}`}>
        <span className="text-xs text-neutral-500 truncate">{loc}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
            tier === 'expired'
              ? 'bg-rose-950/90 text-rose-200 border border-rose-500/40'
              : tier === 'reverify'
                ? 'bg-ds-warning/10 text-ds-warning border border-ds-warning/45'
                : row.custodyStatus === 'on_floor'
                  ? 'bg-sky-950/50 text-sky-200 border border-sky-700/40'
                  : 'bg-ds-elevated text-neutral-400 border border-ds-line/50'
          }`}
        >
          {tier === 'expired' ? 'EXPIRED' : row.custodyStatus === 'on_floor' ? 'FLOOR' : 'STOCK'}
        </span>
      </div>
    </div>
  )
}

function columnPosForShade(full: ShadeCardSpotlightRow[], id: string) {
  const idx = full.findIndex((r) => r.id === id)
  if (idx < 0) return { rank: 0, isFirst: true, isLast: true }
  return { rank: idx + 1, isFirst: idx === 0, isLast: idx === full.length - 1 }
}

function DraggableKanbanCard({
  row,
  monoClass,
  onOpen,
  onDeleted,
  columnId,
  columnRows,
  onPriorityRefresh,
  onQuickIssue,
  onQuickReceive,
}: {
  row: ShadeCardSpotlightRow
  monoClass: string
  onOpen: () => void
  onDeleted: () => void
  columnId: ShadeKanbanColumnId
  columnRows: ShadeCardSpotlightRow[]
  onPriorityRefresh: () => void
  onQuickIssue: () => void
  onQuickReceive: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: row.id,
    data: { row },
  })
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.4 : 1 }
    : undefined
  const pri = columnPosForShade(columnRows, row.id)
  const priDomain = shadeHubDomain(columnId)

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2 }}
      className="relative touch-none pl-5 pb-9"
    >
      <HubCardDeleteAction
        asset="shade_card"
        recordId={row.id}
        triggerClassName="absolute right-2 top-2 z-20"
        onDeleted={onDeleted}
        stopPropagationOnTrigger
      />
      <button
        type="button"
        onClick={() => onOpen()}
        className="w-full text-left rounded-xl pr-10 pt-0.5"
      >
        <KanbanCardInner row={row} monoClass={monoClass} priorityRank={pri.rank} />
      </button>
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="absolute left-0 top-2 z-10 flex h-[calc(100%-16px)] w-5 cursor-grab items-start justify-center rounded-l-lg border border-transparent bg-ds-card/40 hover:bg-ds-elevated/80 active:cursor-grabbing touch-none"
        aria-label="Drag to In-Stock or On-Floor"
      >
        <GripVertical className="h-4 w-4 text-neutral-500 shrink-0 mt-1" />
      </button>
      <div className="w-full pl-5 pr-1 min-w-0">
        <HubPriorityReorderAuditFooter
          lastReorderedBy={row.lastReorderedBy}
          lastReorderedAt={row.lastReorderedAt}
        />
        <div className="mt-1 flex flex-wrap items-center gap-1 leading-none">
          {row.custodyStatus === 'in_stock' ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onQuickIssue()
              }}
              className="h-6 rounded-md border border-sky-500/40 bg-sky-500/8 px-2 text-xs font-medium text-sky-700 dark:text-sky-300"
            >
              Issue
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onQuickReceive()
              }}
              className="h-6 rounded-md border border-emerald-500/40 bg-emerald-500/8 px-2 text-xs font-medium text-emerald-700 dark:text-emerald-300"
            >
              Receive
            </button>
          )}
        </div>
      </div>
      <div
        className="absolute bottom-0.5 right-0.5 z-20"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <HubPriorityController
          domain={priDomain}
          entityId={row.id}
          isFirst={pri.isFirst}
          isLast={pri.isLast}
          onSuccess={onPriorityRefresh}
        />
      </div>
    </motion.div>
  )
}

function KanbanColumn({
  col,
  children,
  monoClass,
  count,
}: {
  col: (typeof COLS)[number]
  children: ReactNode
  monoClass: string
  count: number
}) {
  const dropId = col.dropId
  const { setNodeRef, isOver } = useDroppable({
    id: dropId ?? `kanban-static-${col.id}`,
    disabled: !dropId,
    data: { column: col.id },
  })

  return (
    <div className="flex min-w-[220px] max-w-[280px] flex-1 flex-col rounded-xl border border-ds-line/40 bg-background/40">
      <div className={`border-b border-ds-line/40 px-2 py-2 ${monoClass}`}>
        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          {col.title}{' '}
          <span className="text-neutral-600 font-normal">({count})</span>
        </p>
      </div>
      <div
        ref={setNodeRef}
        className={`flex flex-1 flex-col gap-2 p-2 min-h-[200px] ${
          dropId && isOver ? 'bg-emerald-950/20 ring-1 ring-emerald-500/30' : ''
        }`}
      >
        {children}
      </div>
    </div>
  )
}

export function ShadeCardKanbanBoard({
  rows,
  monoClass,
  onCardClick,
  onDataChange,
}: {
  rows: ShadeCardSpotlightRow[]
  monoClass: string
  onCardClick: (row: ShadeCardSpotlightRow) => void
  onDataChange: () => void
}) {
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const [issueOpen, setIssueOpen] = useState(false)
  const [issueRow, setIssueRow] = useState<ShadeCardSpotlightRow | null>(null)
  const [machineId, setMachineId] = useState('')
  const [operatorId, setOperatorId] = useState('')
  const [issueJobCardId, setIssueJobCardId] = useState('')
  const [issueJobCardNumber, setIssueJobCardNumber] = useState<number | null>(null)
  const [jobCardQuery, setJobCardQuery] = useState('')
  const [jobCardHits, setJobCardHits] = useState<JobCardHit[]>([])
  const [jobCardLoading, setJobCardLoading] = useState(false)
  const [operatorSearch, setOperatorSearch] = useState('')
  const [issueInitialCondition, setIssueInitialCondition] = useState<'mint' | 'used' | 'minor_damage'>('mint')

  const [receiveOpen, setReceiveOpen] = useState(false)
  const [receiveRow, setReceiveRow] = useState<ShadeCardSpotlightRow | null>(null)
  const [receiveOperatorId, setReceiveOperatorId] = useState('')
  const [receiveOperatorSearch, setReceiveOperatorSearch] = useState('')
  const [receiveEndCondition, setReceiveEndCondition] = useState<'mint' | 'used' | 'minor_damage'>('mint')

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 10 } }))

  useEffect(() => {
    void (async () => {
      try {
        const [mRes, uRes] = await Promise.all([fetch('/api/machines'), fetch('/api/users')])
        setMachines(safeJsonParseArray<MachineOpt>(await mRes.text(), []))
        setUsers(safeJsonParseArray<UserOpt>(await uRes.text(), []))
        try {
          const savedIssue = localStorage.getItem(SHADE_ISSUE_OPERATOR_KEY)
          const savedReceive = localStorage.getItem(SHADE_RECEIVE_OPERATOR_KEY)
          if (savedIssue) setOperatorId(savedIssue)
          if (savedReceive) setReceiveOperatorId(savedReceive)
        } catch {}
      } catch {
        /* ignore */
      }
    })()
  }, [])

  useEffect(() => {
    if (!issueOpen) return
    const q = jobCardQuery.trim()
    const t = window.setTimeout(() => {
      void (async () => {
        setJobCardLoading(true)
        try {
          const r = await fetch(`/api/inventory-hub/job-cards-quick?q=${encodeURIComponent(q)}`)
          const j = (await r.json()) as { rows?: JobCardHit[] }
          setJobCardHits(Array.isArray(j.rows) ? j.rows : [])
        } catch {
          setJobCardHits([])
        } finally {
          setJobCardLoading(false)
        }
      })()
    }, q ? 220 : 0)
    return () => window.clearTimeout(t)
  }, [issueOpen, jobCardQuery])

  const grouped = useMemo(() => {
    const g: Record<ShadeKanbanColumnId, ShadeCardSpotlightRow[]> = {
      in_stock: [],
      on_floor: [],
      reverify: [],
      expired: [],
    }
    for (const r of rows) {
      g[shadeCardKanbanColumn(r)].push(r)
    }
    for (const k of Object.keys(g) as ShadeKanbanColumnId[]) {
      g[k].sort((a, b) => {
        const oa = shadeOrderValue(a, k)
        const ob = shadeOrderValue(b, k)
        if (oa !== ob) return oa - ob
        if (a.industrialPriority !== b.industrialPriority) return a.industrialPriority ? -1 : 1
        return a.shadeCode.localeCompare(b.shadeCode)
      })
    }
    return g
  }, [rows])

  const activeRow = useMemo(
    () => (activeId ? rows.find((r) => r.id === activeId) ?? null : null),
    [activeId, rows],
  )

  const filteredOperators = useMemo(() => {
    const q = operatorSearch.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => u.name.toLowerCase().includes(q))
  }, [users, operatorSearch])

  const filteredReceiveOperators = useMemo(() => {
    const q = receiveOperatorSearch.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => u.name.toLowerCase().includes(q))
  }, [users, receiveOperatorSearch])

  const openIssue = useCallback((row: ShadeCardSpotlightRow) => {
    setIssueRow(row)
    setMachineId('')
    setOperatorId('')
    setOperatorSearch('')
    setIssueInitialCondition('mint')
    setIssueJobCardId('')
    setIssueJobCardNumber(null)
    setJobCardQuery('')
    setJobCardHits([])
    setIssueOpen(true)
  }, [])

  const submitIssue = useCallback(async () => {
    if (!issueRow) return
    if (!machineId.trim() || !operatorId.trim()) {
      toast.error('Machine and operator are required')
      return
    }
    if (!issueJobCardId.trim()) {
      toast.error('Link an active production job (job card) — required for custody handshake')
      return
    }
    try {
      const r = await fetch(`/api/inventory-hub/shade-cards/${issueRow.id}/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          machineId,
          operatorUserId: operatorId,
          jobCardId: issueJobCardId.trim(),
          initialCondition: issueInitialCondition,
        }),
      })
      const text = await r.text()
      const j = safeJsonParse<{ error?: string; code?: string; duplicate?: boolean }>(text, {})
      if (!r.ok) {
        if (j.code === 'SHADE_EXPIRED') toast.error(j.error ?? 'Card expired — cannot issue')
        else toast.error(j.error ?? 'Issue failed')
        return
      }
      toast.success(j.duplicate ? 'Duplicate suppressed' : 'Issued to floor')
      try { localStorage.setItem(SHADE_ISSUE_OPERATOR_KEY, operatorId) } catch {}
      setIssueOpen(false)
      onDataChange()
    } catch {
      toast.error('Issue failed')
    }
  }, [issueRow, machineId, operatorId, issueJobCardId, issueInitialCondition, onDataChange])

  const submitReceive = useCallback(async () => {
    if (!receiveRow) return
    if (!receiveOperatorId.trim()) {
      toast.error('Select returning operator (staff directory)')
      return
    }
    try {
      const r = await fetch(`/api/inventory-hub/shade-cards/${receiveRow.id}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          finalImpressions: 0,
          endCondition: receiveEndCondition,
          returningOperatorUserId: receiveOperatorId,
        }),
      })
      const text = await r.text()
      const j = safeJsonParse<{ error?: string; duplicate?: boolean; damageReport?: boolean }>(text, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Receive failed')
        return
      }
      if (j.duplicate) toast.message('Duplicate suppressed')
      else toast.success('Received to rack')
      if (j.damageReport) {
        toast.warning('Damage report logged — end condition below checkout baseline (see spotlight timeline).')
      }
      try { localStorage.setItem(SHADE_RECEIVE_OPERATOR_KEY, receiveOperatorId) } catch {}
      setReceiveOpen(false)
      onDataChange()
    } catch {
      toast.error('Receive failed')
    }
  }, [receiveRow, receiveEndCondition, receiveOperatorId, onDataChange])

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveId(null)
      const { active, over } = e
      if (!over) return
      const row = rows.find((r) => r.id === active.id)
      if (!row) return
      const overId = String(over.id)
      if (overId !== DROP_IN_STOCK && overId !== DROP_ON_FLOOR) return

      if (overId === DROP_ON_FLOOR && row.custodyStatus === 'in_stock') {
        openIssue(row)
        return
      }
      if (overId === DROP_IN_STOCK && row.custodyStatus === 'on_floor') {
        setReceiveRow(row)
        setReceiveOperatorId('')
        setReceiveOperatorSearch('')
        setReceiveEndCondition('mint')
        setReceiveOpen(true)
        return
      }
    },
    [rows, openIssue],
  )

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={({ active }) => setActiveId(String(active.id))}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <motion.div
          className="flex flex-nowrap gap-3 pb-2 justify-start min-w-min"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
        >
          {COLS.map((col) => (
            <KanbanColumn key={col.id} col={col} monoClass={monoClass} count={grouped[col.id].length}>
              <AnimatePresence initial={false} mode="popLayout">
                {grouped[col.id].map((row) => (
                  <DraggableKanbanCard
                    key={row.id}
                    row={row}
                    monoClass={monoClass}
                    onOpen={() => onCardClick(row)}
                    onDeleted={() => onDataChange()}
                    columnId={col.id}
                    columnRows={grouped[col.id]}
                    onPriorityRefresh={onDataChange}
                    onQuickIssue={() => openIssue(row)}
                    onQuickReceive={() => {
                      setReceiveRow(row)
                      setReceiveOperatorSearch('')
                      setReceiveEndCondition('mint')
                      setReceiveOpen(true)
                    }}
                  />
                ))}
              </AnimatePresence>
            </KanbanColumn>
          ))}
        </motion.div>
        <DragOverlay dropAnimation={null}>
          {activeRow ? <KanbanCardInner row={activeRow} monoClass={monoClass} isOverlay /> : null}
        </DragOverlay>
      </DndContext>

      {issueOpen && issueRow ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-background/70 p-4">
          <div className={`w-full max-w-md rounded-lg border border-ds-line/50 bg-ds-card p-4 space-y-3 text-sm ${monoClass}`}>
            <h2 className="text-lg font-semibold text-foreground font-sans">Issue to floor</h2>
            <p className="text-xs text-neutral-500 font-sans">
              Card <span className="text-ds-warning">{issueRow.shadeCode}</span> → On-Floor
            </p>
            <label className="block text-neutral-400 font-sans">
              Job card link <span className="text-ds-warning">(required)</span>
              <input
                value={jobCardQuery}
                onChange={(e) => {
                  setJobCardQuery(e.target.value)
                  setIssueJobCardId('')
                  setIssueJobCardNumber(null)
                }}
                className="mt-1 w-full px-2 py-2 rounded bg-ds-elevated border border-ds-line/50 text-foreground"
                placeholder="Search # or customer…"
              />
            </label>
            {issueJobCardId && issueJobCardNumber != null ? (
              <p className="text-xs text-emerald-300 font-sans">
                <span className={monoClass}>JC #{issueJobCardNumber}</span> linked
                <button
                  type="button"
                  className="ml-2 text-sky-400 underline"
                  onClick={() => {
                    setIssueJobCardId('')
                    setIssueJobCardNumber(null)
                    setJobCardQuery('')
                  }}
                >
                  Clear
                </button>
              </p>
            ) : null}
            {jobCardLoading ? <p className="text-xs text-neutral-500">Searching…</p> : null}
            {!issueJobCardId && jobCardHits.length > 0 ? (
              <ul className="max-h-28 overflow-y-auto rounded border border-ds-line/50 divide-y divide-ds-elevated text-xs">
                {jobCardHits.map((jc) => (
                  <li key={jc.id}>
                    <button
                      type="button"
                      className="w-full text-left px-2 py-1.5 hover:bg-ds-elevated text-ds-ink font-sans"
                      onClick={() => {
                        setIssueJobCardId(jc.id)
                        setIssueJobCardNumber(jc.jobCardNumber)
                        setJobCardQuery(`#${jc.jobCardNumber} · ${jc.customer.name}`)
                      }}
                    >
                      <span className={monoClass}>JC #{jc.jobCardNumber}</span> · {jc.customer.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <label className="block text-neutral-400 font-sans">
              Initial condition <span className="text-neutral-500 font-normal">(checkout)</span>
              <select
                value={issueInitialCondition}
                onChange={(e) =>
                  setIssueInitialCondition(e.target.value as 'mint' | 'used' | 'minor_damage')
                }
                className={`mt-1 w-full px-2 py-2 rounded bg-ds-elevated border border-ds-line/50 text-foreground ${monoClass}`}
              >
                <option value="mint">{shadeCardPhysicalLabel('mint')}</option>
                <option value="used">{shadeCardPhysicalLabel('used')}</option>
                <option value="minor_damage">{shadeCardPhysicalLabel('minor_damage')}</option>
              </select>
            </label>
            <label className="block text-neutral-400 font-sans">
              Machine
              <select
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-ds-elevated border border-ds-line/50 text-foreground"
              >
                <option value="">Select</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.machineCode} — {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-neutral-400 font-sans">
              Operator search <span className="text-neutral-500 font-normal">(staff directory)</span>
              <input
                value={operatorSearch}
                onChange={(e) => setOperatorSearch(e.target.value)}
                placeholder="Filter by name…"
                className={`mt-1 w-full px-2 py-2 rounded bg-ds-elevated border border-ds-line/50 text-foreground ${monoClass}`}
              />
            </label>
            <label className="block text-neutral-400 font-sans">
              Operator
              <select
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-ds-elevated border border-ds-line/50 text-foreground"
              >
                <option value="">Select</option>
                {filteredOperators.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIssueOpen(false)}
                className="px-3 py-1.5 rounded border border-ds-line/50 text-ds-ink font-sans"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitIssue()}
                className="px-3 py-1.5 rounded bg-blue-600 text-primary-foreground font-sans"
              >
                Confirm issue
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {receiveOpen && receiveRow ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-background/70 p-4">
          <div className="w-full max-w-md rounded-lg border border-ds-line/50 bg-ds-card p-4 space-y-3 text-sm font-sans">
            <h2 className="text-lg font-semibold text-foreground">Receive to rack</h2>
            <p className="text-xs text-neutral-500">
              Card <span className={`text-ds-warning ${monoClass}`}>{receiveRow.shadeCode}</span>
            </p>
            <label className="block text-neutral-400 text-sm">
              Returning operator <span className="text-neutral-500">(verify)</span>
              <input
                value={receiveOperatorSearch}
                onChange={(e) => setReceiveOperatorSearch(e.target.value)}
                placeholder="Search staff…"
                className={`mt-1 w-full px-2 py-2 rounded bg-ds-elevated border border-ds-line/50 text-foreground ${monoClass}`}
              />
            </label>
            <label className="block text-neutral-400 text-sm">
              Staff pick
              <select
                value={receiveOperatorId}
                onChange={(e) => setReceiveOperatorId(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-ds-elevated border border-ds-line/50 text-foreground"
              >
                <option value="">Select operator</option>
                {filteredReceiveOperators.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-neutral-400 text-sm">
              End condition
              <select
                value={receiveEndCondition}
                onChange={(e) =>
                  setReceiveEndCondition(e.target.value as 'mint' | 'used' | 'minor_damage')
                }
                className={`mt-1 w-full px-2 py-2 rounded bg-ds-elevated border border-ds-line/50 text-foreground ${monoClass}`}
              >
                <option value="mint">{shadeCardPhysicalLabel('mint')}</option>
                <option value="used">{shadeCardPhysicalLabel('used')}</option>
                <option value="minor_damage">{shadeCardPhysicalLabel('minor_damage')}</option>
              </select>
            </label>
            <label className="block text-neutral-400 text-sm">
              Return to rack
              <input
                readOnly
                value={SHADE_MASTER_RACK_LOCATION}
                className={`mt-1 w-full px-2 py-2 rounded bg-ds-main border border-ds-line/50 text-neutral-400 ${monoClass}`}
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setReceiveOpen(false)}
                className="px-3 py-1.5 rounded border border-ds-line/50 text-ds-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitReceive()}
                className="px-3 py-1.5 rounded bg-emerald-600 text-primary-foreground"
              >
                Receive
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
