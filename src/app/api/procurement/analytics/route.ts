import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { n, ymd } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

function monthKey(d: Date) {
  return d.toISOString().slice(0, 7)
}

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error
  const since = new Date()
  since.setMonth(since.getMonth() - 12)

  const [pos, prs, receipts] = await Promise.all([
    db.vendorMaterialPurchaseOrder.findMany({
      where: { orderDate: { gte: since } },
      include: { supplier: true, lines: true },
      orderBy: { orderDate: 'asc' },
    }),
    db.purchaseRequisition.findMany({
      where: { status: { in: ['draft', 'pending', 'approved'] } },
      include: { material: true },
      orderBy: { raisedAt: 'asc' },
      take: 300,
    }),
    db.vendorMaterialReceipt.findMany({
      where: { receiptDate: { gte: since } },
      include: { vendorPo: { include: { supplier: true, lines: true } } },
      orderBy: { receiptDate: 'asc' },
    }),
  ])

  const monthly = new Map<string, number>()
  const category = new Map<string, number>()
  const supplier = new Map<string, number>()
  const item = new Map<string, number>()
  const overduePoTrend = new Map<string, number>()
  const postingTrend = new Map<string, number>()
  const rejectionItems = new Map<string, number>()
  const now = Date.now()

  for (const po of pos) {
    const total = po.lines.reduce((s, line) => s + n(line.totalWeightKg) * n(line.ratePerKg), 0)
    monthly.set(monthKey(po.orderDate), (monthly.get(monthKey(po.orderDate)) ?? 0) + total)
    supplier.set(po.supplier.name, (supplier.get(po.supplier.name) ?? 0) + total)
    if (po.requiredDeliveryDate && po.requiredDeliveryDate.getTime() < now && !['received', 'closed', 'cancelled'].includes(po.status)) {
      overduePoTrend.set(monthKey(po.requiredDeliveryDate), (overduePoTrend.get(monthKey(po.requiredDeliveryDate)) ?? 0) + 1)
    }
    for (const line of po.lines) {
      category.set(line.boardGrade, (category.get(line.boardGrade) ?? 0) + n(line.totalWeightKg) * n(line.ratePerKg))
      item.set(line.boardGrade, (item.get(line.boardGrade) ?? 0) + n(line.totalWeightKg))
    }
  }
  for (const r of receipts) {
    postingTrend.set(monthKey(r.receiptDate), (postingTrend.get(monthKey(r.receiptDate)) ?? 0) + 1)
    if (n(r.qtyRejected) > 0) {
      for (const line of r.vendorPo.lines) {
        rejectionItems.set(line.boardGrade, (rejectionItems.get(line.boardGrade) ?? 0) + n(r.qtyRejected))
      }
    }
  }

  return NextResponse.json({
    monthlyPurchaseValue: [...monthly.entries()].map(([month, value]) => ({ month, value })),
    categoryWisePurchaseValue: [...category.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([category, value]) => ({ category, value })),
    supplierWisePurchaseValue: [...supplier.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([supplier, value]) => ({ supplier, value })),
    pendingPrAging: prs.map((pr) => ({ id: pr.id, item: pr.material.materialCode, status: pr.status, ageDays: Math.floor((now - pr.raisedAt.getTime()) / 86400000), requiredDate: ymd(pr.requiredByDate) })),
    pendingPoAging: pos.filter((po) => !['received', 'closed', 'cancelled'].includes(po.status)).map((po) => ({ id: po.id, poNumber: po.poNumber, supplier: po.supplier.name, status: po.status, ageDays: Math.floor((now - po.orderDate.getTime()) / 86400000), expectedDelivery: ymd(po.requiredDeliveryDate) })),
    grnPostingTrend: [...postingTrend.entries()].map(([month, count]) => ({ month, count })),
    overduePoTrend: [...overduePoTrend.entries()].map(([month, count]) => ({ month, count })),
    topPurchasedItems: [...item.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([item, qty]) => ({ item, qty })),
    itemsWithRepeatedRejection: [...rejectionItems.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([item, rejectedQty]) => ({ item, rejectedQty })),
  })
}
