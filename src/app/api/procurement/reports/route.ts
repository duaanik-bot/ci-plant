import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { clampLimit, grnNumber, n, pageSkip, prNumber, ymd } from '@/lib/procurement-foundation'
import { buildRateIntelligence, getPendingSupplierPayables } from '@/lib/procurement-integration'

export const dynamic = 'force-dynamic'

function csv(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  return [headers.join(','), ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? '')).join(','))].join('\n')
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const sp = req.nextUrl.searchParams
  const type = sp.get('type') || 'open-pr'
  const exportFormat = sp.get('export')
  const limit = clampLimit(sp.get('limit'))
  const skip = pageSkip(sp.get('page'), limit)
  const q = (sp.get('q') || '').trim()
  let rows: Record<string, unknown>[] = []
  let total = 0

  if (type === 'open-pr' || type === 'approved-pr-pending-po') {
    const where = { status: type === 'open-pr' ? { in: ['draft', 'pending'] } : 'approved', ...(q ? { material: { materialCode: { contains: q, mode: 'insensitive' as const } } } : {}) }
    const [data, count] = await Promise.all([
      db.purchaseRequisition.findMany({ where, skip, take: limit, orderBy: { raisedAt: 'desc' }, include: { material: true } }),
      db.purchaseRequisition.count({ where }),
    ])
    total = count
    rows = data.map((r) => ({ prNo: prNumber(r.id, r.raisedAt), status: r.status, item: r.material.materialCode, qty: n(r.qtyRequired), requiredDate: ymd(r.requiredByDate), raisedBy: r.raisedBy }))
  } else if (type === 'open-po' || type === 'overdue-po') {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const where = { status: { in: ['draft', 'confirmed', 'sent', 'partial_received'] }, ...(type === 'overdue-po' ? { requiredDeliveryDate: { lt: today } } : {}), ...(q ? { poNumber: { contains: q, mode: 'insensitive' as const } } : {}) }
    const [data, count] = await Promise.all([
      db.vendorMaterialPurchaseOrder.findMany({ where, skip, take: limit, orderBy: { orderDate: 'desc' }, include: { supplier: true, lines: true } }),
      db.vendorMaterialPurchaseOrder.count({ where }),
    ])
    total = count
    rows = data.map((po) => ({ poNumber: po.poNumber, supplier: po.supplier.name, status: po.status, expectedDelivery: ymd(po.requiredDeliveryDate), value: po.lines.reduce((s, line) => s + n(line.totalWeightKg) * n(line.ratePerKg), 0) }))
  } else if (type === 'pending-grn' || type === 'qc-rejection') {
    const where = type === 'qc-rejection' ? { qtyRejected: { gt: 0 } } : { qcStatus: { in: ['DRAFT', 'QC_PENDING', 'QC_ACCEPTED', 'QC_REJECTED', 'PARTIALLY_ACCEPTED'] } }
    const [data, count] = await Promise.all([
      db.vendorMaterialReceipt.findMany({ where, skip, take: limit, orderBy: { receiptDate: 'desc' }, include: { vendorPo: { include: { supplier: true } } } }),
      db.vendorMaterialReceipt.count({ where }),
    ])
    total = count
    rows = data.map((r) => ({ grnNo: grnNumber(r.id, r.receiptDate), poNumber: r.vendorPo.poNumber, supplier: r.vendorPo.supplier.name, receivedQty: n(r.receivedQty), rejectedQty: n(r.qtyRejected), status: r.qcStatus ?? 'QC_PENDING' }))
  } else if (type === 'supplier-performance') {
    const [data, count] = await Promise.all([
      db.supplier.findMany({
        where: { active: true, ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}) },
        skip,
        take: limit,
        orderBy: { name: 'asc' },
        include: { vendorMaterialPos: { include: { lines: true, receipts: true } } },
      }),
      db.supplier.count({ where: { active: true, ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}) } }),
    ])
    total = count
    rows = data.map((s) => {
      const pos = s.vendorMaterialPos
      const receipts = pos.flatMap((po) => po.receipts.map((r) => ({ po, r })))
      const posted = receipts.filter((x) => x.r.qcStatus === 'POSTED_TO_STOCK' || x.r.qcPerformedAt)
      const onTime = posted.filter((x) => !x.po.requiredDeliveryDate || x.r.receiptDate <= x.po.requiredDeliveryDate).length
      const received = receipts.reduce((sum, x) => sum + n(x.r.receivedQty), 0)
      const rejected = receipts.reduce((sum, x) => sum + n(x.r.qtyRejected), 0)
      return {
        supplier: s.name,
        gst: s.gstNumber ?? '',
        paymentTerms: s.paymentTerms ?? '',
        totalProcurementValue: pos.reduce((sum, po) => sum + po.lines.reduce((x, l) => x + n(l.totalWeightKg) * n(l.ratePerKg), 0), 0),
        openPoValue: pos.filter((po) => !['received', 'closed', 'cancelled'].includes(po.status)).reduce((sum, po) => sum + po.lines.reduce((x, l) => x + n(l.totalWeightKg) * n(l.ratePerKg), 0), 0),
        onTimeDeliveryPct: posted.length ? Number(((onTime / posted.length) * 100).toFixed(1)) : 0,
        qcAcceptancePct: received > 0 ? Number((((received - rejected) / received) * 100).toFixed(1)) : 100,
        rejectionPct: received > 0 ? Number(((rejected / received) * 100).toFixed(1)) : 0,
      }
    })
  } else if (type === 'purchase-rate-variation') {
    const pos = await db.vendorMaterialPurchaseOrder.findMany({
      where: q ? { lines: { some: { boardGrade: { contains: q, mode: 'insensitive' as const } } } } : {},
      orderBy: { orderDate: 'desc' },
      take: 500,
      include: { lines: true },
    })
    const byItem = new Map<string, Array<{ rate: number; date: Date }>>()
    for (const po of pos) {
      for (const line of po.lines) {
        const key = line.boardGrade || 'Material'
        const arr = byItem.get(key) ?? []
        arr.push({ rate: n(line.ratePerKg), date: po.orderDate })
        byItem.set(key, arr)
      }
    }
    rows = Array.from(byItem.entries()).map(([item, history]) => {
      const r = buildRateIntelligence({ item, rows: history })
      return {
        item: r.item,
        lastPurchaseRate: r.lastPurchaseRate,
        previousPurchaseRate: r.previousPurchaseRate,
        threeMonthAverage: r.threeMonthAverage,
        sixMonthAverage: r.sixMonthAverage,
        bestHistoricalRate: r.bestHistoricalRate,
        highestHistoricalRate: r.highestHistoricalRate,
        flag: r.flag,
      }
    }).slice(skip, skip + limit)
    total = byItem.size
  } else if (type === 'monthly-procurement-summary') {
    const receipts = await db.vendorMaterialReceipt.findMany({
      where: { qcStatus: 'POSTED_TO_STOCK' },
      orderBy: { receiptDate: 'desc' },
      take: 500,
      include: { vendorPo: { include: { supplier: true, lines: true } } },
    })
    const byMonth = new Map<string, { grns: number; value: number; acceptedQty: number; rejectedQty: number }>()
    for (const r of receipts) {
      const month = r.receiptDate.toISOString().slice(0, 7)
      const row = byMonth.get(month) ?? { grns: 0, value: 0, acceptedQty: 0, rejectedQty: 0 }
      const accepted = n(r.qtyAcceptedStandard) + n(r.qtyAcceptedPenalty)
      const ordered = r.vendorPo.lines.reduce((sum, line) => sum + n(line.totalWeightKg), 0)
      row.grns += 1
      row.acceptedQty += accepted
      row.rejectedQty += n(r.qtyRejected)
      row.value += r.vendorPo.lines.reduce((sum, line) => sum + n(line.ratePerKg) * accepted * (ordered > 0 ? n(line.totalWeightKg) / ordered : 0), 0)
      byMonth.set(month, row)
    }
    rows = Array.from(byMonth.entries()).map(([month, r]) => ({ month, grns: r.grns, acceptedQty: r.acceptedQty, rejectedQty: r.rejectedQty, procurementValue: r.value })).slice(skip, skip + limit)
    total = byMonth.size
  } else if (type === 'pending-supplier-invoices') {
    const data = (await getPendingSupplierPayables()).filter((p) => !q || p.supplierName.toLowerCase().includes(q.toLowerCase()) || p.poNumber.toLowerCase().includes(q.toLowerCase()))
    total = data.length
    rows = data.slice(skip, skip + limit).map((p) => ({
      payableReference: p.payableReference,
      poNumber: p.poNumber,
      supplier: p.supplierName,
      accruedPayableInr: p.accruedPayableInr,
      latestGrnDate: p.latestGrnDate,
      invoiceStatus: p.invoiceStatus,
      paymentStatus: p.paymentStatus,
    }))
  }

  if (exportFormat === 'csv') {
    return new NextResponse(csv(rows), { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${type}.csv"` } })
  }
  return NextResponse.json({ type, rows, total, page: Math.floor(skip / limit) + 1, limit })
}
