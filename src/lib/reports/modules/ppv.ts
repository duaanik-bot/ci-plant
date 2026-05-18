import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtInr, fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface PpvInput {
  vendor: string
  boardGrade: string
  gsm: number
  qtyKg: number
  basicRate: number
  landedRate: number
  freightPerKg: number
  unloadingPerKg: number
  insurancePerKg: number
  stdRate: number | null
}

export function computePpv(input: PpvInput[]): ReportResult {
  const rows = input.map((i) => {
    const hasBase = i.stdRate != null
    const std = i.stdRate ?? 0
    const priceVar = hasBase ? (i.basicRate - std) * i.qtyKg : 0
    const freightVar = i.freightPerKg * i.qtyKg
    const unloadingVar = i.unloadingPerKg * i.qtyKg
    const insuranceVar = i.insurancePerKg * i.qtyKg
    return {
      vendor: i.vendor,
      boardGrade: i.boardGrade,
      gsm: i.gsm,
      qtyKg: i.qtyKg,
      stdRate: i.stdRate,
      basicRate: i.basicRate,
      landedRate: i.landedRate,
      basicPpv: hasBase ? (i.basicRate - std) * i.qtyKg : 0,
      landedPpv: hasBase ? (i.landedRate - std) * i.qtyKg : 0,
      priceVar, freightVar, unloadingVar, insuranceVar,
      baseline: hasBase ? 'ok' : 'no baseline',
    }
  })

  const counted = rows.filter((r) => r.baseline === 'ok')
  const totalLanded = counted.reduce((s, r) => s + r.landedPpv, 0)
  const totalBasic = counted.reduce((s, r) => s + r.basicPpv, 0)
  const spend = counted.reduce((s, r) => s + r.landedRate * r.qtyKg, 0)
  const worst = [...counted].sort((a, b) => b.landedPpv - a.landedPpv)[0]

  return {
    columns: [
      { key: 'vendor', label: 'Vendor', type: 'text' },
      { key: 'boardGrade', label: 'Board', type: 'text' },
      { key: 'gsm', label: 'GSM', type: 'num' },
      { key: 'qtyKg', label: 'Qty (kg)', type: 'num', total: true },
      { key: 'stdRate', label: 'Std ₹/kg', type: 'inr' },
      { key: 'basicRate', label: 'Basic ₹/kg', type: 'inr' },
      { key: 'landedRate', label: 'Landed ₹/kg', type: 'inr' },
      { key: 'basicPpv', label: 'Basic PPV', type: 'inr', total: true },
      { key: 'landedPpv', label: 'Landed PPV', type: 'inr', total: true },
      { key: 'priceVar', label: 'Price Var', type: 'inr', total: true },
      { key: 'freightVar', label: 'Freight Var', type: 'inr', total: true },
      { key: 'unloadingVar', label: 'Unloading Var', type: 'inr', total: true },
      { key: 'insuranceVar', label: 'Insurance Var', type: 'inr', total: true },
      { key: 'baseline', label: 'Baseline', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'Total Landed PPV', value: fmtInr(totalLanded), tone: totalLanded > 0 ? 'bad' : 'good' },
      { label: 'Total Basic PPV', value: fmtInr(totalBasic), tone: totalBasic > 0 ? 'bad' : 'good' },
      { label: 'PPV % of Spend', value: fmtPct(spend ? (totalLanded / spend) * 100 : 0) },
      { label: 'Worst Vendor', value: worst ? `${worst.vendor} (${fmtInr(worst.landedPpv)})` : '—' },
    ],
    chart: {
      kind: 'stacked', x: 'boardGrade',
      series: ['priceVar', 'freightVar', 'unloadingVar', 'insuranceVar'],
      data: rows,
    },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({
  vendor: optionalId,
  boardGrade: optionalId,
})
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'ppv', title: 'Purchase Price Variance', group: 'procurement' as const,
  kpi: 'Actual vs weighted-avg cost — decomposed by price, freight, unloading, insurance',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const lines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: {
      vendorPo: {
        createdAt: { gte: filters.from, lte: filters.to },
        ...(filters.vendor ? { supplier: { name: { contains: filters.vendor, mode: 'insensitive' } } } : {}),
      },
      ...(filters.boardGrade ? { boardGrade: { contains: filters.boardGrade, mode: 'insensitive' } } : {}),
    },
    include: { vendorPo: { include: { supplier: true } } },
  })

  const baselines = await db.inventory.findMany({
    select: { boardType: true, gsm: true, weightedAvgCost: true },
  })
  const baseFor = (grade: string, gsm: number) => {
    const m = baselines.find(
      (b) => (b.boardType ?? '').toLowerCase() === grade.toLowerCase() && b.gsm === gsm
    )
    return m ? Number(m.weightedAvgCost) : null
  }

  const input: PpvInput[] = lines.map((l) => {
    const qtyKg = Number(l.totalWeightKg) || 0
    return {
      vendor: l.vendorPo.supplier.name,
      boardGrade: l.boardGrade,
      gsm: l.gsm,
      qtyKg,
      basicRate: Number(l.ratePerKg) || 0,
      landedRate: Number(l.landedRatePerKg) || Number(l.ratePerKg) || 0,
      freightPerKg: qtyKg ? Number(l.freightTotalInr) / qtyKg : 0,
      unloadingPerKg: qtyKg ? Number(l.unloadingChargesInr) / qtyKg : 0,
      insurancePerKg: qtyKg ? Number(l.insuranceMiscInr) / qtyKg : 0,
      stdRate: baseFor(l.boardGrade, l.gsm),
    }
  })

  const result = computePpv(input)
  result.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
    ...(filters.vendor ? { vendor: filters.vendor } : {}),
    ...(filters.boardGrade ? { boardGrade: filters.boardGrade } : {}),
  }
  return result
}
