import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface YieldInput {
  date: string; jobCard: string; machine: string; operator: string
  totalPieces: number; goodPieces: number; yield: number; incentiveEligible: boolean
}

export function computeYield(input: YieldInput[]): ReportResult {
  const avgYield = input.length ? input.reduce((s, i) => s + i.yield, 0) / input.length : 0
  const incentive = input.filter((i) => i.incentiveEligible).length
  const worst = [...input].sort((a, b) => a.yield - b.yield)[0]
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'jobCard', label: 'Job Card', type: 'text' },
      { key: 'machine', label: 'Machine', type: 'text' },
      { key: 'operator', label: 'Operator', type: 'text' },
      { key: 'totalPieces', label: 'Total', type: 'num', total: true },
      { key: 'goodPieces', label: 'Good', type: 'num', total: true },
      { key: 'yield', label: 'Yield %', type: 'pct' },
      { key: 'incentiveEligible', label: 'Incentive', type: 'text' },
    ],
    rows: input as unknown as Record<string, unknown>[],
    summary: [
      { label: 'Avg Yield %', value: fmtPct(avgYield), tone: avgYield >= 96 ? 'good' : 'bad' },
      { label: 'Incentive-Eligible Jobs', value: String(incentive), tone: 'neutral' },
      { label: 'Worst Job', value: worst ? `${worst.jobCard} (${fmtPct(worst.yield)})` : '—', tone: 'bad' },
    ],
    chart: { kind: 'line', x: 'date', series: ['yield'], data: input as any },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ machineId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'yield', title: 'Yield Report', group: 'production' as const,
  kpi: 'Good vs total pieces (target ≥ 96%)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const ledgers = await db.productionOeeLedger.findMany({
    where: {
      computedAt: { gte: filters.from, lte: filters.to },
      ...(filters.machineId ? { machineId: filters.machineId } : {}),
    },
    include: {
      machine: { select: { machineCode: true } },
      attributedOperator: { select: { name: true } },
      jobCard: { select: { id: true } },
    },
  })
  const input: YieldInput[] = ledgers.map((l) => ({
    date: l.computedAt.toISOString(),
    jobCard: l.jobCard?.id?.slice(0, 8) ?? l.productionJobCardId.slice(0, 8),
    machine: l.machine?.machineCode ?? '—',
    operator: l.attributedOperator?.name ?? '—',
    totalPieces: l.totalPieces,
    goodPieces: l.goodPieces,
    yield: Number(l.yieldPercent) || 0,
    incentiveEligible: l.incentiveEligible,
  }))
  const r = computeYield(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
