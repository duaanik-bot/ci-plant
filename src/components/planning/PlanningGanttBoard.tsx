'use client'

import { useMemo } from 'react'
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import Link from 'next/link'
import { Star } from 'lucide-react'
import {
  computeJobRunHours,
  computeLaneFinishes,
  formatDurationHMM,
  priorityRippleForLane,
  sheetsEstimateForLine,
} from '@/lib/planning-analytics'
import { INDUSTRIAL_PRIORITY_STAR_ICON_CLASS } from '@/lib/industrial-priority-ui'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type Machine = {
  id: string
  machineCode: string
  name: string
  capacityPerShift: number
  specification?: string | null
}

type GanttLine = {
  id: string
  cartonName: string
  quantity: number
  po: { poNumber: string; id: string; isPriority?: boolean }
  directorPriority?: boolean
  materialQueue?: { totalSheets: number } | null
  specOverrides?: { machineId?: string } | null
}

function linePriority(l: GanttLine): boolean {
  return l.po.isPriority === true || l.directorPriority === true
}

function SortableGanttBlock({
  id,
  line,
  widthPct,
  durationHours,
  finishIso,
  ripple,
  priorityGlow,
}: {
  id: string
  line: GanttLine
  widthPct: number
  durationHours: number
  finishIso: string | null
  ripple?: { delayedJobs: number; delayedHours: number }
  priorityGlow: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    width: `${Math.max(widthPct, 6)}%`,
    minWidth: 72,
  }

  const finishLabel = finishIso
    ? new Date(finishIso).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—'

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`shrink-0 rounded border px-1 py-1 cursor-grab active:cursor-grabbing ${
        priorityGlow
          ? 'border-ds-warning bg-ds-warning/15 shadow-[0_0_22px_rgba(245,158,11,0.45)] ring-1 ring-ds-warning/35'
          : 'border-border/20 bg-ds-card/90'
      } ${isDragging ? 'opacity-70 z-10' : ''}`}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-0.5">
        <Link
          href={`/orders/purchase-orders/${line.po.id}`}
          onClick={(e) => e.stopPropagation()}
          className={`text-[9px] text-ds-warning/90 hover:underline truncate ${mono}`}
        >
          {line.po.poNumber}
        </Link>
        {linePriority(line) ? (
          <Star className={`h-3 w-3 shrink-0 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`} aria-label="Priority" />
        ) : null}
      </div>
      <p className="text-[9px] text-ds-ink-muted truncate leading-tight" title={line.cartonName}>
        {line.cartonName}
      </p>
      <p className={`text-[9px] text-ds-ink-faint mt-0.5 ${mono}`}>{formatDurationHMM(durationHours)}</p>
      <p className={`text-[8px] text-ds-ink-faint ${mono}`}>Fin: {finishLabel}</p>
      {ripple && ripple.delayedJobs > 0 ? (
        <p className="text-[8px] text-ds-warning/90 mt-0.5" title="Delivery ripple — jobs after this priority slot">
          Ripple: +{ripple.delayedJobs} job · +{formatDurationHMM(ripple.delayedHours)}
        </p>
      ) : null}
    </div>
  )
}

export function PlanningGanttBoard({
  machines,
  lines,
  laneOrderByMachine,
  onLaneOrderChange,
  onPersistFinishes,
}: {
  machines: Machine[]
  lines: GanttLine[]
  laneOrderByMachine: Record<string, string[]>
  onLaneOrderChange: (machineId: string, orderedIds: string[]) => void
  onPersistFinishes: (
    payload: {
      machineId: string
      orderedLineIds: string[]
      projectedFinishes: Record<string, string>
    }[],
  ) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines])

  const machineById = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines])

  const lanes = useMemo(() => {
    const mids = Object.keys(laneOrderByMachine).filter((mid) => (laneOrderByMachine[mid]?.length ?? 0) > 0)
    return mids
      .map((mid) => {
        const m = machineById.get(mid)
        if (!m) return null
        return { machine: m, ids: laneOrderByMachine[mid] ?? [] }
      })
      .filter(Boolean) as { machine: Machine; ids: string[] }[]
  }, [laneOrderByMachine, machineById])

  function handleDragEnd(machineId: string, ids: string[], event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(ids, oldIndex, newIndex)
    onLaneOrderChange(machineId, next)
    const m = machineById.get(machineId)
    if (!m) return
    const { finishByLineId } = computeLaneFinishes({
      orderedLineIds: next,
      lineById: new Map(
        next.map((id) => {
          const l = lineById.get(id)
          return [
            id,
            {
              quantity: l?.quantity ?? 0,
              materialQueue: l?.materialQueue ?? null,
            },
          ]
        }),
      ),
      capacityPerShift: m.capacityPerShift,
    })
    onPersistFinishes([{ machineId, orderedLineIds: next, projectedFinishes: finishByLineId }])
  }

  if (lanes.length === 0) {
    return (
      <p className={`text-[11px] text-ds-ink-faint ${mono}`}>
        Assign a press to at least one open line to show the Gantt timeline.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ds-ink-faint">Time-block Gantt (drag to re-sequence)</h2>
      {lanes.map(({ machine, ids }) => {
        let totalH = 0
        const hoursByLineId: Record<string, number> = {}
        for (const id of ids) {
          const l = lineById.get(id)
          const sheets = l
            ? sheetsEstimateForLine({
                quantity: l.quantity,
                materialQueueTotalSheets: l.materialQueue?.totalSheets ?? null,
              })
            : 1
          const h = computeJobRunHours({ sheets, capacityPerShift: machine.capacityPerShift })
          hoursByLineId[id] = h
          totalH += h
        }
        const { finishByLineId } = computeLaneFinishes({
          orderedLineIds: ids,
          lineById: new Map(
            ids.map((id) => {
              const l = lineById.get(id)
              return [
                id,
                {
                  quantity: l?.quantity ?? 0,
                  materialQueue: l?.materialQueue ?? null,
                },
              ]
            }),
          ),
          capacityPerShift: machine.capacityPerShift,
        })
        const priSet = new Set(ids.filter((id) => lineById.get(id) && linePriority(lineById.get(id)!)))
        const ripples = priorityRippleForLane({
          orderedLineIds: ids,
          priorityLineIds: priSet,
          hoursByLineId,
        })

        return (
          <div key={machine.id} className="rounded-lg border border-border/10 bg-background p-2">
            <div className={`flex items-center justify-between text-[10px] text-ds-ink-muted mb-1.5 ${mono}`}>
              <span className="text-ds-warning font-semibold">{machine.machineCode}</span>
              <span>
                Σ {formatDurationHMM(totalH)} · finish{' '}
                {ids.length
                  ? new Date(finishByLineId[ids[ids.length - 1]]).toLocaleString('en-IN', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '—'}
              </span>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => handleDragEnd(machine.id, ids, e)}
            >
              <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
                <div className="flex flex-nowrap gap-1 overflow-x-auto pb-1 items-stretch min-h-[4.5rem]">
                  {ids.map((id) => {
                    const line = lineById.get(id)
                    if (!line) return null
                    const h = hoursByLineId[id] ?? 0
                    const pct = totalH > 0 ? (h / totalH) * 100 : 100 / ids.length
                    return (
                      <SortableGanttBlock
                        key={id}
                        id={id}
                        line={line}
                        widthPct={pct}
                        durationHours={h}
                        finishIso={finishByLineId[id] ?? null}
                        ripple={ripples[id]}
                        priorityGlow={linePriority(line)}
                      />
                    )
                  })}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        )
      })}
    </div>
  )
}
