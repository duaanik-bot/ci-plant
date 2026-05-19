import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtInr } from '../format'
import type { ReportResult } from '../types'

export interface SeInput {
  po: string; customer: string; carton: string
  poQty: number; deliveredQty: number; tolerancePct: number; unitRate: number
}

export function computeShortExcess(input: SeInput[]): ReportResult {
  const rows = input.map((i) => {
    const diff = i.deliveredQty - i.poQty
    const allowed = i.poQty * (i.tolerancePct / 100)
    const within = Math.abs(diff) <= allowed
    return {
      po: i.po, customer: i.customer, carton: i.carton,
      poQty: i.poQty, deliveredQty: i.deliveredQty,
      shortQty: diff < 0 ? -diff : 0,
      excessQty: diff > 0 ? diff : 0,
      variancePct: i.poQty ? (diff / i.poQty) * 100 : 0,
      withinTolerance: within ? 'Yes' : 'No',
      seValue: Math.abs(diff) * i.unitRate,
    }
  })
  const totalShort = rows.reduce((s, r) => s + Number(r.shortQty), 0)
  const totalExcess = rows.reduce((s, r) => s + Number(r.excessQty), 0)
  const outside = rows.filter((r) => r.withinTolerance === 'No').length
  const seValue = rows.reduce((s, r) => s + Number(r.seValue), 0)
  return {
    columns: [
      { key: 'po', label: 'PO', type: 'text' },
      { key: 'customer', label: 'Customer', type: 'text' },
      { key: 'carton', label: 'Carton', type: 'text' },
      { key: 'poQty', label: 'PO Qty', type: 'num', total: true },
      { key: 'deliveredQty', label: 'Delivered', type: 'num', total: true },
      { key: 'shortQty', label: 'Short', type: 'num', total: true },
      { key: 'excessQty', label: 'Excess', type: 'num', total: true },
      { key: 'variancePct', label: 'Variance %', type: 'pct' },
      { key: 'withinTolerance', label: 'Within Tol', type: 'text' },
      { key: 'seValue', label: 'S&E ₹', type: 'inr', total: true },
    ],
    rows,
    summary: [
      { label: 'Total Short', value: String(totalShort), tone: totalShort ? 'bad' : 'good' },
      { label: 'Total Excess', value: String(totalExcess), tone: totalExcess ? 'bad' : 'good' },
      { label: 'Outside Tolerance', value: String(outside), tone: outside ? 'bad' : 'good' },
      { label: 'S&E Value', value: fmtInr(seValue), tone: 'bad' },
    ],
    chart: {
      kind: 'bar', x: 'customer', series: ['shortQty', 'excessQty'], data: rows,
    },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ customerId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'short-excess', title: 'Short & Excess', group: 'delivery' as const,
  kpi: 'Delivered vs PO qty against tolerance band',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const recs = await db.shortExcessRecord.findMany({
    where: {
      createdAt: { gte: filters.from, lte: filters.to },
      ...(filters.customerId
        ? { poLineItem: { po: { customerId: filters.customerId } } }
        : {}),
    },
    include: {
      poLineItem: {
        include: { po: { include: { customer: { select: { name: true } } } } },
      },
    },
  })
  const input: SeInput[] = recs.map((s) => ({
    po: s.poLineItem.po.poNumber,
    customer: s.poLineItem.po.customer.name,
    carton: s.poLineItem.cartonName,
    poQty: s.poQty,
    deliveredQty: s.actualQty,
    tolerancePct: Number(s.tolerancePct) || 0,
    unitRate: Number(s.poLineItem.rate) || 0,
  }))
  const r = computeShortExcess(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
