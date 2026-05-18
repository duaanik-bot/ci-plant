import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import type { ReportResult } from '../types'

export interface DtInput { reason: string; minutes: number }

export function computeDowntimePareto(input: DtInput[]): ReportResult {
  const byReason = new Map<string, { minutes: number; occurrences: number }>()
  for (const i of input) {
    const cur = byReason.get(i.reason) ?? { minutes: 0, occurrences: 0 }
    cur.minutes += i.minutes
    cur.occurrences += 1
    byReason.set(i.reason, cur)
  }
  const total = input.reduce((s, i) => s + i.minutes, 0)
  const sorted = Array.from(byReason.entries()).sort((a, b) => b[1].minutes - a[1].minutes)
  let cum = 0
  const rows = sorted.map(([reason, v]) => {
    cum += v.minutes
    return {
      reason,
      occurrences: v.occurrences,
      minutes: v.minutes,
      pctOfTotal: total ? (v.minutes / total) * 100 : 0,
      cumulativePct: total ? (cum / total) * 100 : 0,
    }
  })
  const top = sorted[0]
  return {
    columns: [
      { key: 'reason', label: 'Reason', type: 'text' },
      { key: 'occurrences', label: 'Occurrences', type: 'num', total: true },
      { key: 'minutes', label: 'Downtime (min)', type: 'num', total: true },
      { key: 'pctOfTotal', label: '% of Total', type: 'pct' },
      { key: 'cumulativePct', label: 'Cumulative %', type: 'pct' },
    ],
    rows,
    summary: [
      { label: 'Total Downtime (min)', value: String(total), tone: 'bad' },
      { label: 'Top Reason', value: top ? `${top[0]} (${top[1].minutes} min)` : '—', tone: 'bad' },
      { label: 'Distinct Reasons', value: String(sorted.length) },
    ],
    chart: { kind: 'pareto', x: 'reason', series: ['minutes', 'cumulativePct'], data: rows },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ machineId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'downtime-pareto', title: 'Downtime Pareto', group: 'production' as const,
  kpi: 'Downtime minutes by reason (80/20 view)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const logs = await db.productionDowntimeLog.findMany({
    where: {
      startedAt: { gte: filters.from, lte: filters.to },
      ...(filters.machineId ? { machineId: filters.machineId } : {}),
    },
    select: { reasonCategory: true, durationSeconds: true },
  })
  const input: DtInput[] = logs.map((l) => ({
    reason: l.reasonCategory,
    minutes: Math.round((l.durationSeconds ?? 0) / 60),
  }))
  const r = computeDowntimePareto(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
