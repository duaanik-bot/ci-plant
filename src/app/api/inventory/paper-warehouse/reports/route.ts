import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

  const pos = await db.vendorMaterialPurchaseOrder.findMany({
    where: { orderDate: { gte: ninetyDaysAgo } },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { totalWeightKg: true, ratePerKg: true } },
      receipts: {
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
  })

  // Spend by vendor
  const spendMap = new Map<string, { totalInr: number; poCount: number }>()
  for (const po of pos) {
    const name = po.supplier.name
    const spend = po.lines.reduce(
      (s, l) => s + Number(l.totalWeightKg) * Number(l.ratePerKg ?? 0),
      0,
    )
    const cur = spendMap.get(name) ?? { totalInr: 0, poCount: 0 }
    spendMap.set(name, { totalInr: cur.totalInr + spend, poCount: cur.poCount + 1 })
  }
  const spendByVendor = Array.from(spendMap.entries())
    .map(([vendorName, v]) => ({ vendorName, ...v }))
    .sort((a, b) => b.totalInr - a.totalInr)

  // Receipt accuracy by vendor
  const accuracyMap = new Map<string, { orderedKg: number; receivedKg: number }>()
  for (const po of pos) {
    const name = po.supplier.name
    const orderedKg = po.lines.reduce((s, l) => s + Number(l.totalWeightKg), 0)
    const receivedKg = Number(po.totalReceivedKg)
    const cur = accuracyMap.get(name) ?? { orderedKg: 0, receivedKg: 0 }
    accuracyMap.set(name, {
      orderedKg: cur.orderedKg + orderedKg,
      receivedKg: cur.receivedKg + receivedKg,
    })
  }
  const receiptAccuracy = Array.from(accuracyMap.entries()).map(([vendorName, v]) => ({
    vendorName,
    orderedKg: v.orderedKg,
    receivedKg: v.receivedKg,
    accuracyPct: v.orderedKg > 0 ? Math.round((v.receivedKg / v.orderedKg) * 100) : 0,
  }))

  // Lead time trend — avg days from orderDate to first receipt, grouped by month
  const leadMap = new Map<string, { totalDays: number; count: number }>()
  for (const po of pos) {
    const firstReceipt = po.receipts[0]
    if (!firstReceipt) continue
    const days = Math.floor(
      (firstReceipt.createdAt.getTime() - po.orderDate.getTime()) / 86_400_000,
    )
    if (days < 0) continue
    const month = po.orderDate.toISOString().slice(0, 7) // "2026-05"
    const cur = leadMap.get(month) ?? { totalDays: 0, count: 0 }
    leadMap.set(month, { totalDays: cur.totalDays + days, count: cur.count + 1 })
  }
  const leadTimeTrend = Array.from(leadMap.entries())
    .map(([month, v]) => ({ month, avgDays: Math.round(v.totalDays / v.count) }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6)

  return NextResponse.json({ spendByVendor, receiptAccuracy, leadTimeTrend })
}
