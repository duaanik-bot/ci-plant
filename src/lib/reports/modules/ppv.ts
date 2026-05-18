import { z } from 'zod'
import { withDateRange, optionalId } from '../filters'
import { fmtInr, fmtPct } from '../format'
import type { ReportModule, ReportResult } from '../types'

// ── Filter schema ────────────────────────────────────────────────────────────
export const filterSchema = withDateRange({
  vendor: optionalId,
  boardGrade: optionalId,
})

export type PpvFilters = z.infer<typeof filterSchema>

// ── Meta ─────────────────────────────────────────────────────────────────────
export const meta: Omit<ReportModule<PpvFilters>, 'filterSchema' | 'query'> = {
  id: 'ppv',
  title: 'Purchase Price Variance',
  group: 'procurement',
  kpi: 'Total Landed PPV',
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface PpvInput {
  vendor: string
  material: string
  boardGrade: string
  /** kg purchased */
  qtyKg: number
  /** actual basic rate ₹/kg */
  basicRate: number
  /** standard (budgeted) rate ₹/kg — null when no baseline exists */
  standardRate: number | null
  freightPerKg: number
  unloadingPerKg: number
  insurancePerKg: number
}

// ── Core computation (pure, tested) ─────────────────────────────────────────
export interface PpvRow {
  vendor: string
  material: string
  boardGrade: string
  qtyKg: number
  basicRate: number
  standardRate: number | null
  freightPerKg: number
  unloadingPerKg: number
  insurancePerKg: number
  priceVar: number
  freightVar: number
  unloadingVar: number
  insuranceVar: number
  totalVar: number
  baseline: 'ok' | 'missing'
}

export function computePpv(inputs: PpvInput[]): {
  rows: PpvRow[]
  counted: PpvRow[]
  totalPriceVar: number
  totalFreightVar: number
  totalUnloadingVar: number
  totalInsuranceVar: number
  totalLandedVar: number
} {
  const rows: PpvRow[] = inputs.map((i) => {
    const hasBase = i.standardRate != null
    const std = i.standardRate ?? 0

    const priceVar = hasBase ? (i.basicRate - std) * i.qtyKg : 0
    const freightVar = hasBase ? i.freightPerKg * i.qtyKg : 0
    const unloadingVar = hasBase ? i.unloadingPerKg * i.qtyKg : 0
    const insuranceVar = hasBase ? i.insurancePerKg * i.qtyKg : 0

    return {
      vendor: i.vendor,
      material: i.material,
      boardGrade: i.boardGrade,
      qtyKg: i.qtyKg,
      basicRate: i.basicRate,
      standardRate: i.standardRate,
      freightPerKg: i.freightPerKg,
      unloadingPerKg: i.unloadingPerKg,
      insurancePerKg: i.insurancePerKg,
      priceVar,
      freightVar,
      unloadingVar,
      insuranceVar,
      totalVar: priceVar + freightVar + unloadingVar + insuranceVar,
      baseline: hasBase ? 'ok' : 'missing',
    }
  })

  // Only rows with a baseline count towards variance totals and chart
  const counted = rows.filter((r) => r.baseline === 'ok')

  const sum = (fn: (r: PpvRow) => number) =>
    counted.reduce((acc, r) => acc + fn(r), 0)

  return {
    rows,
    counted,
    totalPriceVar: sum((r) => r.priceVar),
    totalFreightVar: sum((r) => r.freightVar),
    totalUnloadingVar: sum((r) => r.unloadingVar),
    totalInsuranceVar: sum((r) => r.insuranceVar),
    totalLandedVar: sum((r) => r.totalVar),
  }
}

// ── Query (stub — real impl wires Prisma) ────────────────────────────────────
export async function query(_filters: PpvFilters): Promise<ReportResult> {
  // In production this would fetch from DB. Here we return an empty result.
  const { rows, counted, totalLandedVar, totalPriceVar, totalFreightVar } =
    computePpv([])

  return {
    columns: [
      { key: 'vendor', label: 'Vendor', type: 'text' },
      { key: 'material', label: 'Material', type: 'text' },
      { key: 'boardGrade', label: 'Board Grade', type: 'text' },
      { key: 'qtyKg', label: 'Qty (kg)', type: 'num', total: true },
      { key: 'basicRate', label: 'Basic Rate', type: 'inr' },
      { key: 'standardRate', label: 'Std Rate', type: 'inr' },
      { key: 'priceVar', label: 'Price Var', type: 'inr', total: true },
      { key: 'freightVar', label: 'Freight Var', type: 'inr', total: true },
      { key: 'unloadingVar', label: 'Unloading Var', type: 'inr', total: true },
      { key: 'insuranceVar', label: 'Insurance Var', type: 'inr', total: true },
      { key: 'totalVar', label: 'Total Landed Var', type: 'inr', total: true },
      { key: 'baseline', label: 'Baseline', type: 'text' },
    ],
    rows: rows as unknown as Record<string, unknown>[],
    summary: [
      { label: 'Total Landed PPV', value: fmtInr(totalLandedVar), tone: totalLandedVar > 0 ? 'bad' : totalLandedVar < 0 ? 'good' : 'neutral' },
      { label: 'Price Component', value: fmtInr(totalPriceVar) },
      { label: 'Freight Component', value: fmtInr(totalFreightVar) },
    ],
    chart: {
      kind: 'stacked',
      x: 'vendor',
      series: ['priceVar', 'freightVar', 'unloadingVar', 'insuranceVar'],
      data: counted as unknown as Record<string, unknown>[],
    },
    meta: {
      generatedAt: new Date().toISOString(),
      filtersApplied: {
        from: _filters.from.toISOString(),
        to: _filters.to.toISOString(),
      },
    },
  }
}
