import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { n, ymd } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const supplierId = req.nextUrl.searchParams.get('supplierId') || undefined
  const suppliers = await db.supplier.findMany({
    where: { active: true, ...(supplierId ? { id: supplierId } : {}) },
    take: supplierId ? 1 : 50,
    orderBy: { name: 'asc' },
    include: {
      vendorMaterialPos: {
        take: 200,
        orderBy: { orderDate: 'desc' },
        include: { lines: true, receipts: true },
      },
    },
  })
  const rows = suppliers.map((s) => {
    const pos = s.vendorMaterialPos
    const totalPurchaseValue = pos.reduce((sum, po) => sum + po.lines.reduce((x, l) => x + n(l.totalWeightKg) * n(l.ratePerKg), 0), 0)
    const openPoValue = pos.filter((po) => !['received', 'closed', 'cancelled'].includes(po.status)).reduce((sum, po) => sum + po.lines.reduce((x, l) => x + n(l.totalWeightKg) * n(l.ratePerKg), 0), 0)
    const receipts = pos.flatMap((po) => po.receipts.map((r) => ({ po, receipt: r })))
    const delivered = receipts.filter((x) => x.receipt.qcStatus === 'POSTED_TO_STOCK' || x.receipt.qcPerformedAt)
    const avgLead = delivered.length ? delivered.reduce((sum, x) => sum + Math.max(0, (x.receipt.receiptDate.getTime() - x.po.orderDate.getTime()) / 86400000), 0) / delivered.length : 0
    const onTime = delivered.filter((x) => !x.po.requiredDeliveryDate || x.receipt.receiptDate <= x.po.requiredDeliveryDate).length
    const lateDeliveryCount = delivered.length - onTime
    const totalReceived = receipts.reduce((sum, x) => sum + n(x.receipt.receivedQty), 0)
    const totalRejected = receipts.reduce((sum, x) => sum + n(x.receipt.qtyRejected), 0)
    const lastLine = pos[0]?.lines[0] ?? null
    const rates = pos.flatMap((po) => po.lines.map((line) => n(line.ratePerKg)).filter((r) => r > 0))
    const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0
    const consistency = avgRate > 0 && rates.length > 1 ? Math.max(0, 100 - (Math.sqrt(rates.reduce((s2, r) => s2 + (r - avgRate) ** 2, 0) / rates.length) / avgRate) * 100) : 100
    const deliveryScore = delivered.length ? (onTime / delivered.length) * 100 : 80
    const qualityScore = totalReceived > 0 ? Math.max(0, 100 - (totalRejected / totalReceived) * 100) : 100
    const responsivenessScore = 75
    const supplierScore = deliveryScore * 0.4 + qualityScore * 0.3 + consistency * 0.2 + responsivenessScore * 0.1
    return {
      id: s.id,
      supplierName: s.name,
      overview: {
        supplierName: s.name,
        gst: s.gstNumber,
        contact: [s.contactName, s.contactPhone, s.email].filter(Boolean).join(' / ') || null,
        paymentTerms: s.paymentTerms,
      },
      commercial: {
        lastPurchaseRate: lastLine?.ratePerKg == null ? null : n(lastLine.ratePerKg),
        averageRate: avgRate,
        openPoValue,
        totalProcurementValue: totalPurchaseValue,
      },
      operational: {
        leadTime: Number(avgLead.toFixed(1)),
        onTimeDeliveryPct: delivered.length ? Number(((onTime / delivered.length) * 100).toFixed(1)) : 0,
        qcAcceptancePct: totalReceived > 0 ? Number((((totalReceived - totalRejected) / totalReceived) * 100).toFixed(1)) : 100,
        rejectionPct: totalReceived > 0 ? Number(((totalRejected / totalReceived) * 100).toFixed(1)) : 0,
      },
      history: {
        purchaseOrders: pos.slice(0, 10).map((po) => ({ id: po.id, poNumber: po.poNumber, date: ymd(po.orderDate), status: po.status })),
        grns: receipts.slice(0, 10).map((x) => ({ id: x.receipt.id, poNumber: x.po.poNumber, date: ymd(x.receipt.receiptDate), status: x.receipt.qcStatus ?? 'QC_PENDING' })),
        rateHistory: pos.flatMap((po) => po.lines.map((line) => ({ item: line.boardGrade, date: ymd(po.orderDate), rate: n(line.ratePerKg) }))).slice(0, 30),
        notes: pos.map((po) => po.remarks).filter(Boolean).slice(0, 10),
      },
      totalPurchaseValue,
      openPoValue,
      averageDeliveryLeadTime: Number(avgLead.toFixed(1)),
      onTimeDeliveryPct: delivered.length ? Number(((onTime / delivered.length) * 100).toFixed(1)) : 0,
      lateDeliveryCount,
      qcRejectionPct: totalReceived > 0 ? Number(((totalRejected / totalReceived) * 100).toFixed(1)) : 0,
      lastPurchaseRate: lastLine?.ratePerKg == null ? null : n(lastLine.ratePerKg),
      lastPurchaseDate: pos[0] ? ymd(pos[0].orderDate) : null,
      pendingGrns: receipts.filter((x) => x.receipt.qcStatus !== 'POSTED_TO_STOCK' && x.receipt.qcStatus !== 'CANCELLED').length,
      openPayableReference: pos.reduce((sum, po) => sum + n(po.accruedReceiptPayableInr), 0),
      supplierScore: Number(supplierScore.toFixed(1)),
      priceTrendByItem: pos.flatMap((po) => po.lines.map((line) => ({ item: line.boardGrade, date: ymd(po.orderDate), rate: n(line.ratePerKg) }))).slice(0, 30),
    }
  })
  return NextResponse.json({ rows })
}
