import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface OeeInput {
  date: string; machine: string; operator: string
  shiftMin: number; runMin: number
  availability: number; performance: number; quality: number; oee: number
  goodPieces: number; totalPieces: number; yield: number
}

export function computeOee(input: OeeInput[]): ReportResult {
  const avg = (k: keyof OeeInput) =>
    input.length ? input.reduce((s, i) => s + Number(i[k]), 0) / input.length : 0
  const avgOee = avg('oee')
  const below = input.filter((i) => i.oee < 85).length
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'machine', label: 'Machine', type: 'text' },
      { key: 'operator', label: 'Operator', type: 'text' },
      { key: 'shiftMin', label: 'Shift Min', type: 'num' },
      { key: 'runMin', label: 'Run Min', type: 'num' },
      { key: 'availability', label: 'Avail %', type: 'pct' },
      { key: 'performance', label: 'Perf %', type: 'pct' },
      { key: 'quality', label: 'Qual %', type: 'pct' },
      { key: 'oee', label: 'OEE %', type: 'pct' },
      { key: 'goodPieces', label: 'Good', type: 'num', total: true },
      { key: 'totalPieces', label: 'Total', type: 'num', total: true },
      { key: 'yield', label: 'Yield %', type: 'pct' },
    ],
    rows: input as unknown as Record<string, unknown>[],
    summary: [
      { label: 'Avg OEE %', value: fmtPct(avgOee), tone: avgOee >= 85 ? 'good' : 'bad' },
      { label: 'Avg Availability %', value: fmtPct(avg('availability')) },
      { label: 'Avg Performance %', value: fmtPct(avg('performance')) },
      { label: 'Jobs Below Target', value: String(below), tone: below ? 'bad' : 'good' },
    ],
    chart: { kind: 'bar', x: 'machine', series: ['oee'], data: input as any },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ machineId: optionalId, operatorId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'oee', title: 'OEE Report', group: 'production' as const,
  kpi: 'Availability × Performance × Quality (target ≥ 85%)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const ledgers = await db.productionOeeLedger.findMany({
    where: {
      computedAt: { gte: filters.from, lte: filters.to },
      ...(filters.machineId ? { machineId: filters.machineId } : {}),
      ...(filters.operatorId ? { attributedOperatorUserId: filters.operatorId } : {}),
    },
    include: {
      machine: { select: { machineCode: true } },
      attributedOperator: { select: { name: true } },
    },
  })
  const input: OeeInput[] = ledgers.map((l) => ({
    date: l.computedAt.toISOString(),
    machine: l.machine?.machineCode ?? '—',
    operator: l.attributedOperator?.name ?? '—',
    shiftMin: l.shiftMinutes,
    runMin: l.runMinutes,
    availability: Number(l.availabilityPct),
    performance: Number(l.performancePct),
    quality: Number(l.qualityPct),
    oee: Number(l.oeePct),
    goodPieces: l.goodPieces,
    totalPieces: l.totalPieces,
    yield: Number(l.yieldPercent) || 0,
  }))
  const r = computeOee(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
