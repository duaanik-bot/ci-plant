import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtPct } from '../format'
import type { ReportResult } from '../types'

export interface OtifInput {
  po: string; customer: string; carton: string
  poQty: number; dispatchedQty: number; allowedQty: number
  dueDate: string; dispatchedAt: string
}

export function computeOtif(input: OtifInput[]): ReportResult {
  const rows = input.map((i) => {
    const onTime = new Date(i.dispatchedAt).getTime() <= new Date(i.dueDate).getTime()
    const inFull = i.dispatchedQty >= i.poQty && i.dispatchedQty <= i.allowedQty
    const otif = onTime && inFull
    return {
      po: i.po, customer: i.customer, carton: i.carton,
      poQty: i.poQty, dispatchedQty: i.dispatchedQty,
      dueDate: i.dueDate, dispatchedAt: i.dispatchedAt,
      onTime: onTime ? 'Yes' : 'No',
      inFull: inFull ? 'Yes' : 'No',
      otif: otif ? 'Yes' : 'No',
    }
  })
  const n = rows.length || 1
  const otifCount = rows.filter((r) => r.otif === 'Yes').length
  const onTimeCount = rows.filter((r) => r.onTime === 'Yes').length
  const inFullCount = rows.filter((r) => r.inFull === 'Yes').length
  const late = rows.filter((r) => r.onTime === 'No').length
  const short = rows.filter((r) => r.dispatchedQty < r.poQty).length
  const otifPct = (otifCount / n) * 100

  const byCustomer = Array.from(new Set(rows.map((r) => r.customer))).map((c) => {
    const cr = rows.filter((r) => r.customer === c)
    return { customer: c, otifPct: (cr.filter((r) => r.otif === 'Yes').length / cr.length) * 100 }
  })

  return {
    columns: [
      { key: 'po', label: 'PO', type: 'text' },
      { key: 'customer', label: 'Customer', type: 'text' },
      { key: 'carton', label: 'Carton', type: 'text' },
      { key: 'poQty', label: 'PO Qty', type: 'num', total: true },
      { key: 'dispatchedQty', label: 'Dispatched', type: 'num', total: true },
      { key: 'dueDate', label: 'Due', type: 'date' },
      { key: 'dispatchedAt', label: 'Dispatched At', type: 'date' },
      { key: 'onTime', label: 'On-Time', type: 'text' },
      { key: 'inFull', label: 'In-Full', type: 'text' },
      { key: 'otif', label: 'OTIF', type: 'text' },
    ],
    rows,
    summary: [
      { label: 'OTIF %', value: fmtPct(otifPct), tone: otifPct >= 95 ? 'good' : 'bad' },
      { label: 'On-Time %', value: fmtPct((onTimeCount / n) * 100) },
      { label: 'In-Full %', value: fmtPct((inFullCount / n) * 100) },
      { label: 'Late', value: String(late), tone: late ? 'bad' : 'good' },
      { label: 'Short', value: String(short), tone: short ? 'bad' : 'good' },
    ],
    chart: { kind: 'bar', x: 'customer', series: ['otifPct'], data: byCustomer },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ customerId: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'otif', title: 'On-Time-In-Full (OTIF)', group: 'delivery' as const,
  kpi: 'On-time AND in-full delivery vs customer PO (target ≥ 95%)',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const dispatches = await db.dispatch.findMany({
    where: {
      dispatchedAt: { gte: filters.from, lte: filters.to, not: null },
      poLineItem: filters.customerId
        ? { po: { customerId: filters.customerId } } : undefined,
    },
    include: {
      poLineItem: {
        include: {
          po: { include: { customer: { select: { name: true } } } },
        },
      },
      job: { select: { dueDate: true } },
    },
  })
  const input: OtifInput[] = dispatches
    .filter((d) => d.poLineItem)
    .map((d) => {
      const li = d.poLineItem!
      const due = li.po.deliveryRequiredBy ?? d.job?.dueDate ?? d.dispatchedAt!
      return {
        po: li.po.poNumber,
        customer: li.po.customer.name,
        carton: li.cartonName,
        poQty: d.poQtySnapshot ?? li.quantity,
        dispatchedQty: d.qtyDispatched,
        allowedQty: d.allowedQty ?? (d.poQtySnapshot ?? li.quantity),
        dueDate: new Date(due).toISOString(),
        dispatchedAt: d.dispatchedAt!.toISOString(),
      }
    })
  const r = computeOtif(input)
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
