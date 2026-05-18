import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtInr, fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface WasteInput { stage: string; wasteType: string; qty: number; unitCost: number }
export interface ReconInput {
  totalInput: number; goodOutput: number
  wasteRecordQty: number; weightReconWaste: number; yieldImpliedWaste: number
}

const TYPES = ['makeready', 'run_waste', 'substrate_trim'] as const

export function computeWastageMatrix(input: WasteInput[]): ReportResult {
  const stages = Array.from(new Set(input.map((i) => i.stage)))
  const rows = stages.map((stage) => {
    const row: Record<string, unknown> = { stage }
    let stageTotalVal = 0
    for (const t of TYPES) {
      const items = input.filter((i) => i.stage === stage && i.wasteType === t)
      const qty = items.reduce((s, i) => s + i.qty, 0)
      const val = items.reduce((s, i) => s + i.qty * i.unitCost, 0)
      row[`${t}_qty`] = qty
      row[`${t}_val`] = val
      stageTotalVal += val
    }
    row.total_val = stageTotalVal
    return row
  })
  const totalVal = rows.reduce((s, r) => s + (Number(r.total_val) || 0), 0)
  const worst = [...rows].sort((a, b) => Number(b.total_val) - Number(a.total_val))[0]
  return {
    columns: [
      { key: 'stage', label: 'Stage', type: 'text' },
      { key: 'makeready_qty', label: 'Makeready Qty', type: 'num', total: true },
      { key: 'run_waste_qty', label: 'Run Waste Qty', type: 'num', total: true },
      { key: 'substrate_trim_qty', label: 'Trim Qty', type: 'num', total: true },
      { key: 'total_val', label: 'Waste ₹', type: 'inr', total: true },
    ],
    rows,
    summary: [
      { label: 'Total Waste ₹', value: fmtInr(totalVal), tone: 'bad' },
      { label: 'Worst Stage', value: worst ? `${worst.stage} (${fmtInr(Number(worst.total_val))})` : '—' },
    ],
    chart: {
      kind: 'stacked', x: 'stage',
      series: ['makeready_qty', 'run_waste_qty', 'substrate_trim_qty'],
      data: rows,
    },
    views: [{ id: 'matrix', label: 'Stage Matrix' }, { id: 'overall', label: 'Overall Rollup' }],
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export function computeWastageOverall(r: ReconInput): ReportResult {
  const wastePct = r.totalInput ? ((r.totalInput - r.goodOutput) / r.totalInput) * 100 : 0
  const sources = [
    { source: 'WasteRecord', qty: r.wasteRecordQty },
    { source: 'WeightRecon', qty: r.weightReconWaste },
    { source: 'YieldImplied', qty: r.yieldImpliedWaste },
  ]
  const spread = Math.max(...sources.map((s) => s.qty)) - Math.min(...sources.map((s) => s.qty))
  const discrepancy = r.totalInput ? spread > 0.02 * r.totalInput : false
  return {
    columns: [
      { key: 'source', label: 'Source', type: 'text' },
      { key: 'qty', label: 'Implied Waste Qty', type: 'num' },
    ],
    rows: sources,
    summary: [
      { label: 'Total Input', value: String(r.totalInput) },
      { label: 'Good Output', value: String(r.goodOutput) },
      { label: 'Overall Waste %', value: fmtPct(wastePct), tone: wastePct > 5 ? 'bad' : 'good' },
      { label: 'Reconciliation', value: discrepancy ? `Discrepancy (spread ${spread})` : 'Within 5%',
        tone: discrepancy ? 'bad' : 'good' },
    ],
    views: [{ id: 'matrix', label: 'Stage Matrix' }, { id: 'overall', label: 'Overall Rollup' }],
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({
  machineId: optionalId,
  stage: optionalId,
  view: optionalId,
})
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'wastage', title: 'Wastage — Stage-wise & Overall', group: 'material' as const,
  kpi: 'Waste by stage & type, overall waste % with 3-way reconciliation',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const wasteRecords = await db.wasteRecord.findMany({
    where: {
      recordedAt: { gte: filters.from, lte: filters.to },
      ...(filters.machineId ? { machineId: filters.machineId } : {}),
      ...(filters.stage ? { stage: { stageNumber: Number(filters.stage) || -1 } } : {}),
    },
    include: { stage: true, material: { select: { weightedAvgCost: true } } },
  })

  const applied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
    ...(filters.machineId ? { machineId: filters.machineId } : {}),
  }

  if (filters.view === 'overall') {
    const stages = await db.jobStage.findMany({
      where: { startedAt: { gte: filters.from, lte: filters.to } },
      select: { qtyIn: true, qtyOut: true, qtyWaste: true },
    })
    const totalInput = stages.reduce((s, x) => s + (x.qtyIn ?? 0), 0)
    const goodOutput = stages.reduce((s, x) => s + (x.qtyOut ?? 0), 0)
    const wasteRecordQty = wasteRecords.reduce((s, w) => s + Number(w.qty), 0)
    const recon = await db.materialWeightReconciliation.aggregate({
      _sum: { varianceKg: true },
      where: { createdAt: { gte: filters.from, lte: filters.to } },
    })
    const r = computeWastageOverall({
      totalInput, goodOutput,
      wasteRecordQty,
      weightReconWaste: Math.abs(Number(recon._sum.varianceKg) || 0),
      yieldImpliedWaste: totalInput - goodOutput,
    })
    r.meta.filtersApplied = applied
    return r
  }

  const input: WasteInput[] = wasteRecords.map((w) => ({
    stage: w.stage ? `Stage ${w.stage.stageNumber}` : 'Unattributed',
    wasteType: w.wasteType,
    qty: Number(w.qty),
    unitCost: Number(w.material.weightedAvgCost) || 0,
  }))
  const r = computeWastageMatrix(input)
  r.meta.filtersApplied = applied
  return r
}
