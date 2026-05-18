import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface PmInput {
  machine: string; scheduled: number; completed: number; overdue: number
}

export function computePmCompliance(input: PmInput[]): ReportResult {
  const rows = input.map((i) => ({
    machine: i.machine,
    scheduled: i.scheduled,
    completed: i.completed,
    overdue: i.overdue,
    compliancePct: i.scheduled ? (i.completed / i.scheduled) * 100 : 0,
  }))
  const totSched = input.reduce((s, i) => s + i.scheduled, 0)
  const totDone = input.reduce((s, i) => s + i.completed, 0)
  const totOverdue = input.reduce((s, i) => s + i.overdue, 0)
  const plant = totSched ? (totDone / totSched) * 100 : 0
  return {
    columns: [
      { key: 'machine', label: 'Machine', type: 'text' },
      { key: 'scheduled', label: 'Scheduled PMs', type: 'num', total: true },
      { key: 'completed', label: 'Completed PMs', type: 'num', total: true },
      { key: 'overdue', label: 'Overdue', type: 'num', total: true },
      { key: 'compliancePct', label: 'Compliance %', type: 'pct' },
    ],
    rows,
    summary: [
      { label: 'Plant PM Compliance %', value: fmtPct(plant), tone: plant >= 95 ? 'good' : 'bad' },
      { label: 'Overdue PMs', value: String(totOverdue), tone: totOverdue ? 'bad' : 'good' },
      { label: 'Machines Tracked', value: String(input.length) },
    ],
    chart: { kind: 'bar', x: 'machine', series: ['compliancePct'], data: rows },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ machineId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'pm-compliance', title: 'PM Compliance', group: 'maintenance' as const,
  kpi: 'Preventive maintenance completed vs scheduled (target ≥ 95%)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const machines = await db.machine.findMany({
    where: filters.machineId ? { id: filters.machineId } : { status: { not: 'retired' } },
    select: { id: true, machineCode: true, nextPmDue: true },
  })
  const now = new Date()
  const input: PmInput[] = []
  for (const m of machines) {
    const completed = await db.preventiveMaintenanceLog.count({
      where: { machineId: m.id, verifiedAt: { gte: filters.from, lte: filters.to } },
    })
    const dueInRange =
      m.nextPmDue && m.nextPmDue >= filters.from && m.nextPmDue <= filters.to ? 1 : 0
    const scheduled = Math.max(completed + dueInRange, completed)
    const overdue = m.nextPmDue && m.nextPmDue < now && completed === 0 ? 1 : 0
    input.push({
      machine: m.machineCode,
      scheduled: scheduled || (completed === 0 && overdue ? 1 : completed),
      completed,
      overdue,
    })
  }
  const r = computePmCompliance(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
