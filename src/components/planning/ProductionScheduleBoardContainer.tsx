'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { isEmbossingRequired } from '@/lib/emboss-conditions'
import { type PlanningCore } from '@/lib/planning-decision-spec'
import {
  computeFivePointReadiness,
  type ReadinessFiveSegment,
} from '@/lib/planning-interlock'
import { parseCellKey, type ScheduleHandshake } from '@/lib/production-schedule-spec'
import {
  ProductionScheduleBoard,
  type ScheduleLine,
} from '@/components/planning/ProductionScheduleBoard'

type PlanningSpec = {
  machineId?: string
  shift?: string
  plannedDate?: string
  artworkLocksCompleted?: number
  platesStatus?: 'available' | 'partial' | 'new_required'
  dieStatus?: 'good' | 'attention' | 'not_available'
  embossStatus?: 'ready' | 'vendor_ordered' | 'na'
  numberOfColours?: number
  planningGanttIndex?: number
  planningProjectedFinishAt?: string | null
  prodScheduleSlot?: { machineId: string; shift: 1 | 2 | 3; order: number }
  scheduleHandshake?: ScheduleHandshake
  planningCore?: PlanningCore
  planningDesignerDisplayName?: string
}

type InterlockSegment = {
  key: string
  label: string
  ok: boolean
  na?: boolean
  hint?: string
}

type MaterialGate = {
  status: 'unknown' | 'available' | 'ordered' | 'shortage'
  requiredSheets: number | null
  netAvailable: number | null
  procurementStatus: string
}

type PlanningLedger = {
  toolingInterlock: { segments: InterlockSegment[]; allReady: boolean }
  materialGate: MaterialGate
  suggestedMachineId: string | null
  estimatedDurationHours: number
  numberOfColours: number | null
  readinessFive?: { segments: ReadinessFiveSegment[]; allGreen: boolean }
}

type Line = {
  id: string
  cartonId: string | null
  dimLengthMm?: unknown
  dimWidthMm?: unknown
  cartonName: string
  cartonSize: string | null
  quantity: number
  rate: number | null
  gsm: number | null
  coatingType: string | null
  embossingLeafing: string | null
  paperType: string | null
  dyeId: string | null
  remarks: string | null
  setNumber: string | null
  jobCardNumber: number | null
  planningStatus: string
  specOverrides: PlanningSpec | null
  po: {
    id: string
    poNumber: string
    status: string
    poDate: string
    isPriority?: boolean
    customer: { id: string; name: string }
  }
  jobCard?: {
    id: string
    jobCardNumber: number
    artworkApproved: boolean
    firstArticlePass: boolean
    finalQcPass: boolean
    qaReleased: boolean
    plateSetId: string | null
    status: string
    issuedStockDisplay?: string | null
    grainFitStatus?: string
    inventoryLocationPointer?: string | null
    sheetsIssued?: number
    totalSheets?: number
    stages?: { stageName: string; counter: number | null }[]
    allocatedPaperWarehouse?: { lotNumber: string | null } | null
  } | null
  readiness?: {
    artworkLocksCompleted: number
    platesStatus: string
    dieStatus: string
    machineAllocated: boolean
  }
  directorPriority?: boolean
  directorHold?: boolean
  planningLedger?: PlanningLedger
  materialQueue?: {
    totalSheets: number
    ups?: number
    boardType?: string
    gsm?: number
    sheetLengthMm?: unknown
    sheetWidthMm?: unknown
  } | null
  materialProcurementStatus?: string
  shadeCardId?: string | null
  shadeCard?: {
    custodyStatus: string
    mfgDate: string | null
    approvalDate: string | null
    createdAt: string
    isActive: boolean
  } | null
  carton?: {
    blankLength?: unknown
    blankWidth?: unknown
  } | null
  createdAt?: string
}

type Machine = {
  id: string
  machineCode: string
  name: string
  stdWastePct: number | null
  capacityPerShift: number
  specification?: string | null
}

function shadeCardForInterlock(r: Line): {
  custodyStatus: string
  mfgDate: Date | null
  approvalDate: Date | null
  createdAt: Date
  isActive: boolean
} | null {
  if (!r.shadeCard) return null
  const c = r.shadeCard
  return {
    custodyStatus: c.custodyStatus,
    mfgDate: c.mfgDate ? new Date(c.mfgDate) : null,
    approvalDate: c.approvalDate ? new Date(c.approvalDate) : null,
    createdAt: new Date(c.createdAt),
    isActive: c.isActive,
  }
}

function readinessFiveForLine(r: Line): { segments: ReadinessFiveSegment[]; allGreen: boolean } {
  const spec = r.specOverrides || {}
  const artworkLocks = Number(spec.artworkLocksCompleted ?? r.readiness?.artworkLocksCompleted ?? 0)
  const platesStatus = String(spec.platesStatus ?? r.readiness?.platesStatus ?? 'new_required')
  const dieStatus = String(spec.dieStatus ?? r.readiness?.dieStatus ?? (r.dyeId ? 'good' : 'not_available'))
  const embossStatus = String(spec.embossStatus ?? 'vendor_ordered')
  const materialGate =
    r.planningLedger?.materialGate ?? {
      status: 'unknown' as const,
      requiredSheets: null,
      netAvailable: null,
      procurementStatus: '',
    }
  return computeFivePointReadiness({
    artworkLocksCompleted: artworkLocks,
    platesStatus,
    materialGate,
    dieStatus,
    embossingLeafing: r.embossingLeafing,
    embossStatus,
    shadeCardId: r.shadeCardId ?? null,
    shadeCard: shadeCardForInterlock(r),
  })
}

function lineToScheduleLine(l: Line): ScheduleLine {
  return {
    id: l.id,
    cartonName: l.cartonName,
    quantity: l.quantity,
    planningStatus: l.planningStatus,
    po: { poNumber: l.po.poNumber, id: l.po.id, isPriority: l.po.isPriority },
    directorPriority: l.directorPriority,
    materialQueue: l.materialQueue
      ? { totalSheets: l.materialQueue.totalSheets }
      : null,
    specOverrides: l.specOverrides as Record<string, unknown> | null,
    jobCard: l.jobCard
      ? {
          id: l.jobCard.id,
          jobCardNumber: l.jobCard.jobCardNumber,
          sheetsIssued: l.jobCard.sheetsIssued,
          totalSheets: l.jobCard.totalSheets,
          stages: l.jobCard.stages,
        }
      : null,
  }
}

/**
 * Shift grid + drag-drop schedule — lives on Production Planning (`/production/stages`), not Orders Planning.
 */
export function ProductionScheduleBoardContainer() {
  const [rows, setRows] = useState<Line[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)

  const fetchRows = useCallback(async () => {
    const res = await fetch('/api/planning/po-lines')
    const json = await res.json()
    const list = Array.isArray(json) ? (json as Line[]) : []
    setRows(
      list.map((li) => ({
        ...li,
        specOverrides:
          li.specOverrides && typeof li.specOverrides === 'object'
            ? (li.specOverrides as PlanningSpec)
            : null,
      })),
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const machRes = await fetch('/api/machines')
        const machJson = await machRes.json()
        if (!cancelled) {
          setMachines(
            Array.isArray(machJson)
              ? machJson.map((m: Machine) => ({
                  ...m,
                  capacityPerShift: Number(m.capacityPerShift) || 4000,
                }))
              : [],
          )
        }
        await fetchRows()
      } catch {
        toast.error('Failed to load production schedule')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchRows])

  const scheduleSyncSignature = useMemo(
    () =>
      rows
        .map((r) => {
          const s = r.specOverrides || {}
          return `${r.id}:${JSON.stringify(s.prodScheduleSlot ?? null)}:${JSON.stringify(s.scheduleHandshake ?? null)}`
        })
        .sort()
        .join('|'),
    [rows],
  )

  const scheduleReady = useCallback((l: ScheduleLine) => {
    const full = rows.find((r) => r.id === l.id)
    if (!full || full.planningStatus === 'closed') return false
    return readinessFiveForLine(full).allGreen
  }, [rows])

  const persistSchedule = useCallback(
    async (containers: { sidebar: string[]; cells: Record<string, string[]> }) => {
      const touched = new Set<string>()
      containers.sidebar.forEach((id) => touched.add(id))
      for (const ids of Object.values(containers.cells)) {
        for (const id of ids) touched.add(id)
      }
      for (const id of Array.from(touched)) {
        const li = rows.find((r) => r.id === id)
        if (!li) continue
        const inSidebar = containers.sidebar.includes(id)
        const spec = { ...(li.specOverrides || {}) } as Record<string, unknown>
        if (inSidebar) {
          delete spec.prodScheduleSlot
        } else {
          let placement: { machineId: string; shift: 1 | 2 | 3; order: number } | null = null
          for (const [cid, ids] of Object.entries(containers.cells)) {
            const idx = ids.indexOf(id)
            if (idx >= 0) {
              const p = parseCellKey(cid)
              if (p) placement = { machineId: p.machineId, shift: p.shift, order: idx }
              break
            }
          }
          if (placement) {
            spec.machineId = placement.machineId
            spec.shift = String(placement.shift)
            spec.prodScheduleSlot = {
              machineId: placement.machineId,
              shift: placement.shift,
              order: placement.order,
            }
          }
        }
        const res = await fetch(`/api/planning/po-lines/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specOverrides: spec }),
        })
        if (!res.ok) {
          toast.error('Could not save schedule')
          await fetchRows()
          return
        }
      }
      toast.success('Schedule saved')
      await fetchRows()
    },
    [rows, fetchRows],
  )

  const persistHandshake = useCallback(
    async (lineId: string, handshake: ScheduleHandshake) => {
      const li = rows.find((r) => r.id === lineId)
      if (!li) return
      const spec = { ...(li.specOverrides || {}), scheduleHandshake: handshake }
      const res = await fetch(`/api/planning/po-lines/${lineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specOverrides: spec }),
      })
      if (!res.ok) {
        toast.error('Handshake save failed')
        return
      }
      toast.success('Operator handshake saved')
      await fetchRows()
    },
    [rows, fetchRows],
  )

  const scheduleBoardLines = useMemo(
    () => rows.filter((r) => r.planningStatus !== 'closed').map(lineToScheduleLine),
    [rows],
  )

  if (loading) {
    return (
      <div className="rounded-2xl border border-border/10 bg-background px-4 py-8 text-center text-sm text-slate-500">
        Loading production schedule…
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border/10 bg-background px-4 py-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
      <p className="text-xs text-slate-500 mb-3">
        Drag lines from the ready sidebar into machine × shift cells. Changes sync to PO line specs. For readiness and
        job-card actions use{' '}
        <a href="/orders/planning" className="text-orange-400 hover:underline">
          Orders → Planning
        </a>
        .
      </p>
      <ProductionScheduleBoard
        machines={machines}
        lines={scheduleBoardLines}
        readyPredicate={scheduleReady}
        syncSignature={scheduleSyncSignature}
        onPersistSchedule={persistSchedule}
        onPersistHandshake={persistHandshake}
      />
    </div>
  )
}
