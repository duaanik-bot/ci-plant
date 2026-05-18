import { z } from 'zod'
import { db } from '@/lib/db'
import { withDateRange, optionalId } from '../filters'
import { fmtInr } from '../format'
import type { ReportResult } from '../types'

export interface VpInput {
  vendor: string; receipts: number
  qtyReceived: number; qtyRejected: number; debitNoteInr: number
}

export function computeVendorPpm(input: VpInput[]): ReportResult {
  const rows = input.map((i) => ({
    vendor: i.vendor,
    receipts: i.receipts,
    qtyReceived: i.qtyReceived,
    qtyRejected: i.qtyRejected,
    ppm: i.qtyReceived ? Math.round((i.qtyRejected / i.qtyReceived) * 1_000_000) : 0,
    debitNoteInr: i.debitNoteInr,
  }))
  const totRec = input.reduce((s, i) => s + i.qtyReceived, 0)
  const totRej = input.reduce((s, i) => s + i.qtyRejected, 0)
  const overall = totRec ? Math.round((totRej / totRec) * 1_000_000) : 0
  const worst = [...rows].sort((a, b) => b.ppm - a.ppm)[0]
  const totDn = input.reduce((s, i) => s + i.debitNoteInr, 0)
  return {
    columns: [
      { key: 'vendor', label: 'Vendor', type: 'text' },
      { key: 'receipts', label: 'Receipts', type: 'num', total: true },
      { key: 'qtyReceived', label: 'Qty Received', type: 'num', total: true },
      { key: 'qtyRejected', label: 'Qty Rejected', type: 'num', total: true },
      { key: 'ppm', label: 'Reject PPM', type: 'num' },
      { key: 'debitNoteInr', label: 'Debit Note ₹', type: 'inr', total: true },
    ],
    rows,
    summary: [
      { label: 'Overall PPM', value: String(overall), tone: overall > 0 ? 'bad' : 'good' },
      { label: 'Worst Vendor', value: worst ? `${worst.vendor} (${worst.ppm})` : '—', tone: 'bad' },
      { label: 'Total Debit Notes', value: fmtInr(totDn), tone: 'bad' },
    ],
    chart: { kind: 'bar', x: 'vendor', series: ['ppm'], data: rows },
    meta: { generatedAt: new Date().toISOString(), filtersApplied: {} },
  }
}

export const filterSchema = withDateRange({ vendor: optionalId })
type Filters = z.infer<typeof filterSchema>

export const meta = {
  id: 'vendor-quality-ppm', title: 'Vendor Quality PPM', group: 'procurement' as const,
  kpi: 'Incoming reject PPM by vendor + debit-note value',
}

export async function query(filters: Filters): Promise<ReportResult> {
  const receipts = await db.vendorMaterialReceipt.findMany({
    where: { receiptDate: { gte: filters.from, lte: filters.to } },
    include: {
      vendorPo: { include: { supplier: { select: { name: true } } } },
      qualityDebitNote: { select: { amountInr: true } },
    },
  })
  const map = new Map<string, VpInput>()
  for (const rec of receipts) {
    const vendor = rec.vendorPo.supplier.name
    if (filters.vendor && !vendor.toLowerCase().includes(filters.vendor.toLowerCase())) continue
    const cur = map.get(vendor) ?? { vendor, receipts: 0, qtyReceived: 0, qtyRejected: 0, debitNoteInr: 0 }
    cur.receipts += 1
    cur.qtyReceived += Number(rec.receivedQty) || 0
    cur.qtyRejected += Number(rec.qtyRejected) || 0
    cur.debitNoteInr += Number(rec.qualityDebitNote?.amountInr) || 0
    map.set(vendor, cur)
  }
  const r = computeVendorPpm(Array.from(map.values()))
  r.meta.filtersApplied = {
    from: filters.from.toISOString().slice(0, 10),
    to: filters.to.toISOString().slice(0, 10),
  }
  return r
}
