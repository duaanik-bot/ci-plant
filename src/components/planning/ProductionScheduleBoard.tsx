'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import Link from 'next/link'
import { Star } from 'lucide-react'
import {
  computeJobRunHours,
  formatDurationHMM,
  sheetsEstimateForLine,
} from '@/lib/planning-analytics'
import { INDUSTRIAL_PRIORITY_STAR_ICON_CLASS } from '@/lib/industrial-priority-ui'
import {
  batchSegmentsForScheduleBar,
  cellKey,
  liveActualSheets,
  readProdScheduleSlot,
  readScheduleHandshake,
  sheetGapExceedsThreshold,
  type ScheduleHandshake,
  type ShiftIndex,
} from '@/lib/production-schedule-spec'
import { OperatorHandshakeDrawer } from '@/components/planning/OperatorHandshakeDrawer'

const mono = 'font-designing-queue tabular-nums tracking-tight'

const SHIFTS: ShiftIndex[] = [1, 2, 3]

type Machine = {
  id: string
  machineCode: string
  name: string
  capacityPerShift: number
}

export type ScheduleLine = {
  id: string
  cartonName: string
  quantity: number
  planningStatus: string
  po: { poNumber: string; id: string; isPriority?: boolean }
  directorPriority?: boolean
  materialQueue?: { totalSheets: number } | null
  specOverrides?: Record<string, unknown> | null
  jobCard?: {
    id: string
    jobCardNumber: number
    sheetsIssued?: number
    totalSheets?: number
    stages?: { stageName: string; counter: number | null }[]
  } | null
}

function linePriority(l: ScheduleLine): boolean {
  return l.po.isPriority === true || l.directorPriority === true
}

export function buildContainersFromLines(
  machines: Machine[],
  lines: ScheduleLine[],
  readyPredicate: (l: ScheduleLine) => boolean,
): { sidebar: string[]; cells: Record<string, string[]> } {
  const cellIds: Record<string, string[]> = {}
  for (const m of machines) {
    for (const s of SHIFTS) {
      cellIds[cellKey(m.id, s)] = []
    }
  }

  const placed = new Set<string>()
  const withSlot = lines
    .map((l) => ({ line: l, slot: readProdScheduleSlot(l.specOverrides ?? undefined) }))
    .filter((x) => x.slot != null) as {
    line: ScheduleLine
    slot: NonNullable<ReturnType<typeof readProdScheduleSlot>>
  }[]

  withSlot.sort((a, b) => {
    if (a.slot.machineId !== b.slot.machineId) return a.slot.machineId.localeCompare(b.slot.machineId)
    if (a.slot.shift !== b.slot.shift) return a.slot.shift - b.slot.shift
    return a.slot.order - b.slot.order
  })

  for (const { line, slot } of withSlot) {
    const k = cellKey(slot.machineId, slot.shift)
    if (!cellIds[k]) cellIds[k] = []
    cellIds[k].push(line.id)
    placed.add(line.id)
  }

  const sidebar: string[] = []
  for (const l of lines) {
    if (placed.has(l.id)) continue
    if (!readyPredicate(l)) continue
    sidebar.push(l.id)
  }

  return { sidebar, cells: cellIds }
}

function ScheduleCell({
  id,
  children,
}: {
  id: string
  children: import('react').ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div
      ref={setNodeRef}
      className={`border border-slate-800 bg-background p-1 min-h-[7rem] align-top transition-colors ${
        isOver ? 'bg-zinc-900/80 ring-1 ring-amber-500/30' : ''
      }`}
    >
      {children}
    </div>
  )
}

function SortableJobCard({
  line,
  machine,
  gapAlert,
  onRecall,
  onHandshake,
}: {
  line: ScheduleLine
  machine: Machine | null
  gapAlert: boolean
  onRecall: () => void
  onHandshake: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: line.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const sheets = sheetsEstimateForLine({
    quantity: line.quantity,
    materialQueueTotalSheets: line.materialQueue?.totalSheets ?? null,
  })
  const hours =
    machine != null
      ? computeJobRunHours({ sheets, capacityPerShift: machine.capacityPerShift })
      : computeJobRunHours({ sheets, capacityPerShift: 4000 })

  const segments = batchSegmentsForScheduleBar(line.specOverrides ?? undefined, line.po.poNumber)
  const pri = linePriority(line)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded border px-1.5 py-1 text-left ${
        gapAlert
          ? 'border-rose-500 shadow-[0_0_0_1px_rgba(244,63,94,0.5)] bg-rose-950/20'
          : pri
            ? 'border-amber-500 bg-amber-500/10 shadow-[0_0_18px_rgba(245,158,11,0.35)]'
            : 'border-slate-600 bg-zinc-900/95'
      } ${isDragging ? 'opacity-60 z-50' : ''}`}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-0.5">
        <Link
          href={`/orders/purchase-orders/${line.po.id}`}
          onClick={(e) => e.stopPropagation()}
          className={`text-[9px] text-amber-300/90 hover:underline truncate ${mono}`}
        >
          PO {line.po.poNumber}
        </Link>
        {pri ? (
          <Star className={`h-3 w-3 shrink-0 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`} aria-label="Priority" />
        ) : null}
      </div>
      {line.jobCard ? (
        <div className={`text-[8px] text-sky-400/90 ${mono}`}>JC #{line.jobCard.jobCardNumber}</div>
      ) : null}
      <p className="text-[9px] text-slate-400 truncate leading-tight mt-0.5" title={line.cartonName}>
        {line.cartonName}
      </p>
      <p className={`text-[8px] text-slate-500 ${mono}`}>{formatDurationHMM(hours)}</p>

      <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-sm bg-slate-800 gap-px" title="Batch segments (PO)">
        {segments.map((seg) => {
          const bg =
            seg.status === 'done'
              ? 'bg-emerald-500'
              : seg.status === 'active'
                ? 'bg-amber-400 animate-pulse'
                : 'bg-slate-600'
          const tip = `${seg.batchId}${
            seg.completedAtMelbourne ? ` · ${seg.completedAtMelbourne} (Melbourne)` : ''
          }`
          return <span key={seg.batchId} className={`min-w-[3px] flex-1 ${bg}`} title={tip} />
        })}
      </div>

      <div className="mt-1 flex flex-wrap gap-1 justify-end">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onHandshake()
          }}
          className="text-[8px] text-sky-400/90 hover:text-sky-300"
        >
          Handshake
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRecall()
          }}
          className="text-[8px] text-rose-400/90 hover:text-rose-300"
        >
          Recall
        </button>
      </div>
    </div>
  )
}

export function ProductionScheduleBoard({
  machines,
  lines,
  readyPredicate,
  syncSignature,
  onPersistSchedule,
  onPersistHandshake,
}: {
  machines: Machine[]
  lines: ScheduleLine[]
  readyPredicate: (l: ScheduleLine) => boolean
  /** When this string changes (e.g. after fetch), grid re-syncs from spec */
  syncSignature: string
  onPersistSchedule: (containers: { sidebar: string[]; cells: Record<string, string[]> }) => Promise<void>
  onPersistHandshake: (lineId: string, handshake: ScheduleHandshake) => Promise<void>
}) {
  const [sidebar, setSidebar] = useState<string[]>([])
  const [cells, setCells] = useState<Record<string, string[]>>({})

  useEffect(() => {
    const next = buildContainersFromLines(machines, lines, readyPredicate)
    setSidebar(next.sidebar)
    setCells(next.cells)
  }, [syncSignature, machines, lines, readyPredicate])

  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines])
  const machineById = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines])

  const [activeId, setActiveId] = useState<string | null>(null)
  const [handshakeLineId, setHandshakeLineId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const findContainer = useCallback(
    (itemId: string): string | null => {
      if (sidebar.includes(itemId)) return 'sidebar'
      for (const [cid, list] of Object.entries(cells)) {
        if (list.includes(itemId)) return cid
      }
      return null
    },
    [sidebar, cells],
  )

  const resolveOverContainer = useCallback(
    (overId: string): string | null => {
      if (overId === 'sidebar') return 'sidebar'
      if (cells[overId] !== undefined) return overId
      return findContainer(overId)
    },
    [cells, findContainer],
  )

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      if (!over) return

      const activeContainer = findContainer(String(active.id))
      if (!activeContainer) return

      const overId = String(over.id)
      const overContainer = resolveOverContainer(overId)
      if (!overContainer) return

      const a = String(active.id)

      if (activeContainer === overContainer) {
        const items =
          activeContainer === 'sidebar' ? [...sidebar] : [...(cells[activeContainer] ?? [])]
        const oldIndex = items.indexOf(a)
        const newIndex = items.indexOf(overId)
        if (oldIndex < 0 || newIndex < 0) {
          await onPersistSchedule({ sidebar, cells })
          return
        }
        if (oldIndex === newIndex) {
          await onPersistSchedule({ sidebar, cells })
          return
        }
        const next = arrayMove(items, oldIndex, newIndex)
        if (activeContainer === 'sidebar') {
          const nextState = { sidebar: next, cells: { ...cells } }
          setSidebar(next)
          await onPersistSchedule(nextState)
        } else {
          const nextCells = { ...cells, [activeContainer]: next }
          setCells(nextCells)
          await onPersistSchedule({ sidebar, cells: nextCells })
        }
        return
      }

      // Cross-container
      let nextSidebar = [...sidebar]
      let nextCells = { ...cells }

      if (activeContainer === 'sidebar') {
        nextSidebar = nextSidebar.filter((x) => x !== a)
      } else {
        nextCells[activeContainer] = (nextCells[activeContainer] ?? []).filter((x) => x !== a)
      }

      if (overContainer === 'sidebar') {
        let dest = [...nextSidebar]
        let idx = dest.indexOf(overId)
        if (idx < 0) idx = dest.length
        dest.splice(idx, 0, a)
        nextSidebar = dest
      } else {
        let dest = [...(nextCells[overContainer] ?? [])]
        let idx = dest.indexOf(overId)
        if (idx < 0) idx = dest.length
        dest.splice(idx, 0, a)
        nextCells[overContainer] = dest
      }

      setSidebar(nextSidebar)
      setCells(nextCells)
      await onPersistSchedule({ sidebar: nextSidebar, cells: nextCells })

      if (activeContainer === 'sidebar' && overContainer !== 'sidebar') {
        setHandshakeLineId(a)
      }
    },
    [cells, findContainer, onPersistSchedule, resolveOverContainer, sidebar],
  )

  const handleDragStart = useCallback((event: { active: { id: unknown } }) => {
    setActiveId(String(event.active.id))
  }, [])

  const activeLine = activeId ? lineById.get(activeId) : null

  const handshakeLine = handshakeLineId ? lineById.get(handshakeLineId) : null
  const slot = handshakeLine ? readProdScheduleSlot(handshakeLine.specOverrides ?? undefined) : null
  const machineForHandshake = slot
    ? machineById.get(slot.machineId)
    : handshakeLine?.specOverrides?.machineId
      ? machineById.get(String(handshakeLine.specOverrides.machineId))
      : null
  const defaultOee = 85

  const recall = useCallback(
    async (lineId: string) => {
      let nextSidebar = [...sidebar]
      let nextCells = { ...cells }
      for (const k of Object.keys(nextCells)) {
        nextCells[k] = nextCells[k].filter((x) => x !== lineId)
      }
      if (!nextSidebar.includes(lineId)) nextSidebar.push(lineId)
      setSidebar(nextSidebar)
      setCells(nextCells)
      await onPersistSchedule({ sidebar: nextSidebar, cells: nextCells })
    },
    [cells, onPersistSchedule, sidebar],
  )

  return (
    <>
      <div className="space-y-2">
        <h2 className={`text-xs font-semibold uppercase tracking-wide text-slate-500 ${mono}`}>
          Production schedule · shift grid (Melbourne monitor)
        </h2>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={(e) => void handleDragEnd(e)}
        >
          <div className="flex flex-col lg:flex-row gap-3">
            <aside className="w-full lg:w-52 shrink-0 rounded border border-slate-800 bg-background p-2">
              <p className={`text-[10px] font-semibold uppercase text-slate-500 mb-2 ${mono}`}>
                Ready sidebar
              </p>
              <ScheduleCell id="sidebar">
                <SortableContext items={sidebar} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-1.5 min-h-[4rem]">
                    {sidebar.map((id) => {
                      const line = lineById.get(id)
                      if (!line) return null
                      const m = line.specOverrides?.machineId
                        ? machineById.get(String(line.specOverrides.machineId))
                        : null
                      const planned = sheetsEstimateForLine({
                        quantity: line.quantity,
                        materialQueueTotalSheets: line.materialQueue?.totalSheets ?? null,
                      })
                      const actual = liveActualSheets({
                        sheetsIssued: line.jobCard?.sheetsIssued,
                        stageCounters: (line.jobCard?.stages ?? [])
                          .map((s) => s.counter)
                          .filter((c): c is number => c != null && Number.isFinite(c)),
                      })
                      const gapAlert = sheetGapExceedsThreshold({
                        plannedSheets: planned,
                        actualSheets: actual,
                      })
                      return (
                        <SortableJobCard
                          key={id}
                          line={line}
                          machine={m ?? null}
                          gapAlert={gapAlert}
                          onRecall={() => void recall(id)}
                          onHandshake={() => setHandshakeLineId(id)}
                        />
                      )
                    })}
                  </div>
                </SortableContext>
              </ScheduleCell>
            </aside>

            <div className="flex-1 overflow-x-auto">
              <div
                className="grid min-w-[720px]"
                style={{
                  gridTemplateColumns: `6.5rem repeat(${SHIFTS.length}, minmax(0, 1fr))`,
                }}
              >
                <div className="border border-slate-800 bg-background p-1" />
                {SHIFTS.map((s) => (
                  <div
                    key={s}
                    className={`border border-slate-800 bg-zinc-950/80 px-1 py-1 text-center ${mono} text-[10px] text-slate-400`}
                  >
                    Shift {s}
                  </div>
                ))}

                {machines.map((m) => (
                  <Fragment key={m.id}>
                    <div
                      className={`border border-slate-800 bg-background px-2 py-2 flex items-center ${mono} text-[10px] text-amber-400/95 font-semibold`}
                    >
                      {m.machineCode}
                    </div>
                    {SHIFTS.map((s) => {
                      const cid = cellKey(m.id, s)
                      const ids = cells[cid] ?? []
                      return (
                        <ScheduleCell key={cid} id={cid}>
                          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                            <div className="flex flex-col gap-1.5">
                              {ids.map((id) => {
                                const line = lineById.get(id)
                                if (!line) return null
                                const planned = sheetsEstimateForLine({
                                  quantity: line.quantity,
                                  materialQueueTotalSheets: line.materialQueue?.totalSheets ?? null,
                                })
                                const actual = liveActualSheets({
                                  sheetsIssued: line.jobCard?.sheetsIssued,
                                  stageCounters: (line.jobCard?.stages ?? [])
                                    .map((st) => st.counter)
                                    .filter((c): c is number => c != null && Number.isFinite(c)),
                                })
                                const gapAlert = sheetGapExceedsThreshold({
                                  plannedSheets: planned,
                                  actualSheets: actual,
                                })
                                return (
                                  <SortableJobCard
                                    key={id}
                                    line={line}
                                    machine={m}
                                    gapAlert={gapAlert}
                                    onRecall={() => void recall(id)}
                                    onHandshake={() => setHandshakeLineId(id)}
                                  />
                                )
                              })}
                            </div>
                          </SortableContext>
                        </ScheduleCell>
                      )
                    })}
                  </Fragment>
                ))}
              </div>
            </div>
          </div>

          <DragOverlay>
            {activeLine ? (
              <div
                className={`rounded border border-amber-500/60 bg-zinc-900 px-2 py-1 shadow-xl max-w-[11rem] ${mono} text-[10px] text-slate-200`}
              >
                PO {activeLine.po.poNumber}
                <div className="text-[9px] text-slate-500 truncate">{activeLine.cartonName}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {handshakeLine ? (
        <OperatorHandshakeDrawer
          open={!!handshakeLineId}
          onClose={() => setHandshakeLineId(null)}
          title={`${handshakeLine.po.poNumber} · ${machineForHandshake?.machineCode ?? '—'} · ${
            slot ? `Shift ${slot.shift}` : 'Handshake'
          }`}
          defaultOeePct={defaultOee}
          initial={readScheduleHandshake(handshakeLine.specOverrides ?? undefined)}
          saving={saving}
          onSave={async (h) => {
            setSaving(true)
            try {
              await onPersistHandshake(handshakeLine.id, h)
              setHandshakeLineId(null)
            } finally {
              setSaving(false)
            }
          }}
        />
      ) : null}
    </>
  )
}
