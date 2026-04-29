'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { toast } from 'sonner'
import { INDUSTRIAL_PRIORITY_STAR_ICON_CLASS } from '@/lib/industrial-priority-ui'

const mono = 'font-designing-queue tabular-nums tracking-tight'
const TRIAGE = 'triage' as const

type Machine = { id: string; machineCode: string; name: string }

export type PrintPlanningJobCard = {
  id: string
  jobCardNumber: number
  status: string
  machineId: string | null
  postPressRouting: Record<string, unknown> | null
  customer: { id: string; name: string }
  poLine: {
    cartonName: string
    quantity: number
    industrialPriority?: boolean
    poNumber: string
    upsFromSpec: number | null
    designerName: string | null
    batchType: string | null
  } | null
}

type JobCardAuditEvent = {
  id: string
  at: string
  action: string
  tableName: string
  userName: string | null
  summary: string
}

type JobCardDetail = {
  id: string
  jobCardNumber: number
  status: string
  customer: { id: string; name: string }
  requiredSheets: number
  totalSheets: number
  machineId: string | null
  poLine: {
    cartonName: string
    quantity: number
    cartonSize: string | null
    po: { poNumber: string }
  } | null
  productionBible?: {
    sheetSizeLabel: string | null
    ups: number | null
    grainDirection: string | null
  }
  stages?: { id: string; stageName: string; status: string; operator: string | null }[]
  auditTimeline?: JobCardAuditEvent[]
}

function readPrintPlanOrder(jc: PrintPlanningJobCard): number {
  const rout = jc.postPressRouting
  if (!rout || typeof rout !== 'object') return 0
  const pp = rout.printPlan
  if (!pp || typeof pp !== 'object') return 0
  const o = (pp as { order?: unknown }).order
  return typeof o === 'number' ? o : 0
}

function columnForJob(jc: PrintPlanningJobCard, pressIds: string[]): typeof TRIAGE | string {
  const machineSet = new Set(pressIds)
  const rout = jc.postPressRouting
  const pp =
    rout && typeof rout === 'object' && rout.printPlan && typeof rout.printPlan === 'object'
      ? (rout.printPlan as Record<string, unknown>)
      : null
  const lane = pp?.lane === 'machine' ? 'machine' : 'triage'
  const mid = jc.machineId
  if (lane === 'triage' || !mid || !machineSet.has(mid)) return TRIAGE
  return mid
}

function buildBoard(cards: PrintPlanningJobCard[], pressIds: string[]) {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const triage: string[] = []
  const cols: Record<string, string[]> = {}
  for (const pid of pressIds) cols[pid] = []

  for (const jc of cards) {
    const col = columnForJob(jc, pressIds)
    if (col === TRIAGE) triage.push(jc.id)
    else if (cols[col]) cols[col].push(jc.id)
  }

  const sortInLane = (ids: string[]) =>
    [...ids].sort((a, b) => {
      const ja = byId.get(a)
      const jb = byId.get(b)
      if (!ja || !jb) return 0
      const d = readPrintPlanOrder(ja) - readPrintPlanOrder(jb)
      if (d !== 0) return d
      return jb.jobCardNumber - ja.jobCardNumber
    })

  return {
    triageIds: sortInLane(triage),
    machineCols: Object.fromEntries(pressIds.map((pid) => [pid, sortInLane(cols[pid] ?? [])])) as Record<
      string,
      string[]
    >,
  }
}

function Lane({
  id,
  title,
  subtitle,
  children,
}: {
  id: string
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div className="flex min-w-[11rem] flex-1 flex-col rounded-lg border border-ds-line/40 bg-background">
      <div
        className={`border-b border-ds-line/40 px-2 py-2 ${mono} ${
          isOver ? 'bg-ds-warning/10' : 'bg-ds-main/50'
        }`}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-ds-warning">{title}</p>
        {subtitle ? <p className="text-xs text-ds-ink-faint truncate">{subtitle}</p> : null}
      </div>
      <div ref={setNodeRef} className="min-h-[12rem] flex-1 p-1.5">
        {children}
      </div>
    </div>
  )
}

function SortableCard({
  jc,
  onOpenDetail,
  isSelected,
}: {
  jc: PrintPlanningJobCard
  onOpenDetail: (id: string) => void
  isSelected: boolean
}) {
  const po = jc.poLine
  const pri = po?.industrialPriority === true
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: jc.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpenDetail(jc.id)}
      className={`rounded border px-1.5 py-1.5 text-left cursor-grab active:cursor-grabbing ${
        pri
          ? 'border-ds-warning bg-ds-warning/8 shadow-[0_0_14px_rgba(245,158,11,0.25)]'
          : 'border-ds-line/60 bg-ds-card/95'
      } ${isSelected ? 'ring-2 ring-ds-warning/70 shadow-[0_0_0_1px_rgba(245,158,11,0.6)]' : ''} ${
        isDragging ? 'opacity-60 z-50' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-0.5">
        <Link
          href={`/production/job-cards/${jc.id}`}
          onClick={(e) => e.stopPropagation()}
          className={`text-xs text-sky-400/90 hover:underline ${mono}`}
        >
          JC #{jc.jobCardNumber}
        </Link>
        {pri ? (
          <Star className={`h-3 w-3 shrink-0 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`} aria-label="Priority" />
        ) : null}
      </div>
      <p className="text-xs text-ds-ink-muted truncate leading-tight mt-0.5" title={po?.cartonName ?? ''}>
        {po?.cartonName ?? '—'}
      </p>
      <p className={`text-xs text-ds-ink-faint ${mono} mt-0.5`}>
        {po?.poNumber ?? '—'} · Qty {po?.quantity ?? '—'}
        {po?.upsFromSpec != null ? ` · UPS ${po.upsFromSpec}` : ''}
      </p>
      <p className="text-xs text-ds-ink-faint truncate">{jc.customer.name}</p>
    </div>
  )
}

async function persistLane(
  laneKey: typeof TRIAGE | string,
  orderedIds: string[],
  validPressIds: string[],
): Promise<boolean> {
  const isTriage = laneKey === TRIAGE
  const machineId = isTriage ? null : laneKey
  if (!isTriage && !validPressIds.includes(laneKey)) return false

  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i]
    const res = await fetch(`/api/job-cards/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineId,
        postPressRouting: {
          printPlan: {
            lane: isTriage ? 'triage' : 'machine',
            machineId: isTriage ? null : machineId,
            order: i,
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(typeof json.error === 'string' ? json.error : 'Failed to save print plan')
      return false
    }
  }
  return true
}

export function PrintPlanningKanban() {
  const [cards, setCards] = useState<PrintPlanningJobCard[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)
  const [triageIds, setTriageIds] = useState<string[]>([])
  const [machineCols, setMachineCols] = useState<Record<string, string[]>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState<JobCardDetail | null>(null)

  const pressIds = useMemo(
    () =>
      [...machines]
        .sort((a, b) => a.machineCode.localeCompare(b.machineCode))
        .slice(0, 3)
        .map((m) => m.id),
    [machines],
  )

  const machineById = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines])

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id)
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/job-cards/${id}?auditTimeline=1`)
      const json = (await res.json()) as JobCardDetail | { error?: string }
      if (!res.ok || ('error' in json && json.error)) {
        throw new Error(('error' in json && json.error) || 'Failed to load job card detail')
      }
      setDetail(json as JobCardDetail)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load detail')
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [jcRes, machRes] = await Promise.all([
        fetch('/api/job-cards?segment=print_planning'),
        fetch('/api/machines'),
      ])
      const list = await jcRes.json()
      const machJson = await machRes.json()
      const machList: Machine[] = Array.isArray(machJson) ? machJson : []
      if (!jcRes.ok) throw new Error(list?.error || 'Failed to load job cards')

      const rows: PrintPlanningJobCard[] = Array.isArray(list) ? list : []
      const sortedMachines = [...machList].sort((a, b) => a.machineCode.localeCompare(b.machineCode))
      const selected = sortedMachines.slice(0, 3)
      setMachines(selected)
      setCards(rows)
      const ids = selected.map((m) => m.id)
      const built = buildBoard(rows, ids)
      setTriageIds(built.triageIds)
      setMachineCols(built.machineCols)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!detailId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetailId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [detailId])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const findContainer = useCallback(
    (itemId: string): string | null => {
      if (triageIds.includes(itemId)) return TRIAGE
      for (const [mid, list] of Object.entries(machineCols)) {
        if (list.includes(itemId)) return mid
      }
      return null
    },
    [triageIds, machineCols],
  )

  const resolveOverContainer = useCallback(
    (overId: string): string | null => {
      if (overId === TRIAGE) return TRIAGE
      if (machineCols[overId] !== undefined) return overId
      return findContainer(overId)
    },
    [machineCols, findContainer],
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

      let nextTriage = [...triageIds]
      let nextCols = { ...machineCols }

      if (activeContainer === overContainer) {
        const items =
          activeContainer === TRIAGE ? [...nextTriage] : [...(nextCols[activeContainer] ?? [])]
        const oldIndex = items.indexOf(a)
        const newIndex = items.indexOf(overId)
        if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return
        const next = arrayMove(items, oldIndex, newIndex)
        if (activeContainer === TRIAGE) nextTriage = next
        else nextCols = { ...nextCols, [activeContainer]: next }
        setTriageIds(nextTriage)
        setMachineCols(nextCols)
        const ok = await persistLane(activeContainer, next, pressIds)
        if (!ok) void reload()
        return
      }

      if (activeContainer === TRIAGE) {
        nextTriage = nextTriage.filter((x) => x !== a)
      } else {
        nextCols[activeContainer] = (nextCols[activeContainer] ?? []).filter((x) => x !== a)
      }

      if (overContainer === TRIAGE) {
        const dest = [...nextTriage]
        let idx = dest.indexOf(overId)
        if (idx < 0) idx = dest.length
        dest.splice(idx, 0, a)
        nextTriage = dest
      } else {
        const dest = [...(nextCols[overContainer] ?? [])]
        let idx = dest.indexOf(overId)
        if (idx < 0) idx = dest.length
        dest.splice(idx, 0, a)
        nextCols = { ...nextCols, [overContainer]: dest }
      }

      setTriageIds(nextTriage)
      setMachineCols(nextCols)

      const lanesToSave = Array.from(new Set([activeContainer, overContainer]))
      let allOk = true
      for (const lane of lanesToSave) {
        const ids = lane === TRIAGE ? nextTriage : nextCols[lane] ?? []
        const ok = await persistLane(lane, ids, pressIds)
        if (!ok) allOk = false
      }
      if (!allOk) void reload()
    },
    [findContainer, machineCols, pressIds, reload, resolveOverContainer, triageIds],
  )

  if (loading && cards.length === 0) {
    return <div className={`p-6 text-ds-ink-faint ${mono}`}>Loading print plan…</div>
  }

  if (!loading && pressIds.length === 0) {
    return (
      <div className={`rounded-lg border border-ds-line/40 bg-ds-main/40 p-4 text-sm text-ds-ink-muted ${mono}`}>
        No presses found in Machine Master. Add machines first; then this board will show Triage plus three
        presses (by machine code).
      </div>
    )
  }

  const activeCard = activeId ? cardById.get(activeId) : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={(e) => void handleDragEnd(e)}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <Lane id={TRIAGE} title="Triage" subtitle="Unassigned / next-up">
          <SortableContext items={triageIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5">
              {triageIds.map((id) => {
                const jc = cardById.get(id)
                if (!jc) return null
                return (
                  <SortableCard
                    key={id}
                    jc={jc}
                    onOpenDetail={openDetail}
                    isSelected={detailId === id}
                  />
                )
              })}
            </div>
          </SortableContext>
        </Lane>

        {pressIds.map((mid) => {
          const m = machineById.get(mid)
          const ids = machineCols[mid] ?? []
          return (
            <Lane
              key={mid}
              id={mid}
              title={m?.machineCode ?? 'Press'}
              subtitle={m?.name ?? undefined}
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-1.5">
                  {ids.map((id) => {
                    const jc = cardById.get(id)
                    if (!jc) return null
                    return (
                      <SortableCard
                        key={id}
                        jc={jc}
                        onOpenDetail={openDetail}
                        isSelected={detailId === id}
                      />
                    )
                  })}
                </div>
              </SortableContext>
            </Lane>
          )
        })}
      </div>

      <DragOverlay>
        {activeCard ? (
          <div
            className={`rounded border border-ds-warning/60 bg-ds-card px-2 py-1 shadow-xl max-w-[12rem] ${mono} text-xs`}
          >
            JC #{activeCard.jobCardNumber}
            <div className="text-xs text-ds-ink-faint truncate">
              {activeCard.poLine?.cartonName ?? '—'}
            </div>
          </div>
        ) : null}
      </DragOverlay>

      {detailId ? (
        <>
          <div className="fixed inset-0 z-40 bg-black/35" onClick={() => setDetailId(null)} aria-hidden />
          <aside className="fixed right-0 top-0 z-50 h-screen w-full max-w-md overflow-y-auto border-l border-ds-line/40 bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-ds-line/40 px-4 py-3">
              <div>
                <p className={`text-xs uppercase tracking-wide text-ds-ink-faint ${mono}`}>Print planning log</p>
                <h2 className={`text-sm font-semibold text-ds-warning ${mono}`}>
                  {detail?.jobCardNumber ? `JC #${detail.jobCardNumber}` : 'Job card'}
                </h2>
              </div>
              <button
                type="button"
                className="rounded border border-ds-line/50 px-2 py-1 text-xs"
                onClick={() => setDetailId(null)}
              >
                Close
              </button>
            </div>

            {detailLoading ? (
              <div className={`p-4 text-sm text-ds-ink-faint ${mono}`}>Loading detail…</div>
            ) : detail ? (
              <div className="space-y-3 p-4 text-xs">
                <section className="rounded-lg border border-ds-line/40 p-3">
                  <p className={`mb-2 text-xs font-semibold uppercase tracking-wider text-ds-ink-faint ${mono}`}>Snapshot</p>
                  <div className="space-y-1">
                    <p><span className="text-ds-ink-faint">Carton:</span> {detail.poLine?.cartonName ?? '—'}</p>
                    <p><span className="text-ds-ink-faint">Qty:</span> {detail.poLine?.quantity ?? '—'}</p>
                    <p><span className="text-ds-ink-faint">PO:</span> {detail.poLine?.po.poNumber ?? '—'}</p>
                    <p><span className="text-ds-ink-faint">Sheet:</span> {detail.productionBible?.sheetSizeLabel ?? '—'}</p>
                    <p><span className="text-ds-ink-faint">UPS:</span> {detail.productionBible?.ups ?? '—'}</p>
                    <p><span className="text-ds-ink-faint">Status:</span> {detail.status}</p>
                  </div>
                </section>

                <section className="rounded-lg border border-ds-line/40 p-3">
                  <p className={`mb-2 text-xs font-semibold uppercase tracking-wider text-ds-ink-faint ${mono}`}>Stage log</p>
                  <ul className="space-y-1">
                    {(detail.stages ?? []).map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 rounded border border-ds-line/30 px-2 py-1">
                        <span>{s.stageName}</span>
                        <span className="text-ds-ink-faint">{s.status}</span>
                      </li>
                    ))}
                    {(detail.stages ?? []).length === 0 ? <li className="text-ds-ink-faint">No stage entries.</li> : null}
                  </ul>
                </section>

                <section className="rounded-lg border border-ds-line/40 p-3">
                  <p className={`mb-2 text-xs font-semibold uppercase tracking-wider text-ds-ink-faint ${mono}`}>Audit timeline</p>
                  <ul className="space-y-2">
                    {(detail.auditTimeline ?? []).map((ev) => (
                      <li key={ev.id} className="rounded border border-ds-line/30 px-2 py-1">
                        <p className="text-ds-ink-faint">
                          {new Date(ev.at).toLocaleString()} · {ev.action}
                        </p>
                        <p className="text-ds-ink">{ev.summary}</p>
                      </li>
                    ))}
                    {(detail.auditTimeline ?? []).length === 0 ? (
                      <li className="text-ds-ink-faint">No audit entries.</li>
                    ) : null}
                  </ul>
                </section>
              </div>
            ) : (
              <div className={`p-4 text-sm text-ds-ink-faint ${mono}`}>Unable to load detail.</div>
            )}
          </aside>
        </>
      ) : null}
    </DndContext>
  )
}
