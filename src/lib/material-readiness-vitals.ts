import type { PrismaClient } from '@prisma/client'
import { monthlyWeightLossValueInr } from '@/lib/weight-reconciliation'

const MS_DAY = 86_400_000

export const PROCUREMENT_APPROVAL_SIGNATORY = 'Approved by Anik Dua'

export type MaterialReadinessVitals = {
  /** ₹ open vendor material POs (draft + confirmed). */
  openMaterialSpendInr: number
  /** Kilograms expected at gate in the next 7 calendar days. */
  incomingBoardKg7d: number
  /** Confirmed customer POs with at least one pending material line and no matching board in paper warehouse. */
  criticalShortagePoCount: number
  /** % change in average board ₹/kg vs previous calendar month; null if no baseline. */
  priceVariancePct: number | null
  /** Sum of short-weight ₹ impact (variance × rate) MTD from gate reconciliations. */
  monthlyWeightLossInr: number
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0)
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1, 0, 0, 0, 0)
}

/** Warehouse row covers material queue board + gsm (lenient string match on grade). */
export function paperStockCoversBoard(
  stock: { boardGrade: string | null; paperType: string; gsm: number },
  boardType: string,
  gsm: number,
): boolean {
  if (stock.gsm !== gsm) return false
  const b = boardType.trim().toLowerCase()
  if (!b) return false
  const g = (stock.boardGrade || stock.paperType || '').trim().toLowerCase()
  if (!g) return false
  return g.includes(b) || b.includes(g)
}

export async function computeMaterialReadinessVitals(db: PrismaClient): Promise<MaterialReadinessVitals> {
  const now = new Date()
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const sevenDays = new Date(todayMid.getTime() + 7 * MS_DAY)
  const monthStart = startOfMonth(now)
  const prevMonthStart = addMonths(now, -1)

  const [vendorPosOpen, pendingMaterialLines, stockRows, vendorLinesPrice, weightReconsMtd] = await Promise.all([
    db.vendorMaterialPurchaseOrder.findMany({
      where: { status: { in: ['draft', 'confirmed'] }, isShortClosed: false },
      include: { lines: true },
    }),
    db.poLineItem.findMany({
      where: {
        materialProcurementStatus: 'pending',
        po: { status: 'confirmed' },
        materialQueue: { isNot: null },
      },
      include: {
        materialQueue: { select: { boardType: true, gsm: true } },
      },
    }),
    db.paperWarehouse.findMany({
      where: { qtySheets: { gt: 0 } },
      select: { boardGrade: true, paperType: true, gsm: true },
      take: 2000,
    }),
    db.vendorMaterialPurchaseOrderLine.findMany({
      where: {
        ratePerKg: { not: null },
        vendorPo: {
          OR: [
            { orderDate: { gte: prevMonthStart } },
            { createdAt: { gte: prevMonthStart } },
          ],
        },
      },
      select: {
        ratePerKg: true,
        vendorPo: { select: { orderDate: true, createdAt: true } },
      },
    }),
    db.materialWeightReconciliation.findMany({
      where: { createdAt: { gte: monthStart } },
      select: { varianceKg: true, ratePerKgInr: true },
    }),
  ])

  let openMaterialSpendInr = 0
  let incomingBoardKg7d = 0
  for (const vpo of vendorPosOpen) {
    const lineSum = vpo.lines.reduce((ls, li) => {
      const kg = Number(li.totalWeightKg)
      const rate = li.ratePerKg != null ? Number(li.ratePerKg) : 0
      return ls + kg * rate
    }, 0)
    openMaterialSpendInr += lineSum

    const rd = vpo.requiredDeliveryDate
    if (rd) {
      const r = new Date(rd.getFullYear(), rd.getMonth(), rd.getDate())
      if (r >= todayMid && r <= sevenDays) {
        for (const li of vpo.lines) {
          incomingBoardKg7d += Number(li.totalWeightKg)
        }
      }
    }
  }

  const criticalPoIds = new Set<string>()
  for (const li of pendingMaterialLines) {
    const mq = li.materialQueue
    if (!mq) continue
    const hasStock = stockRows.some((s) => paperStockCoversBoard(s, mq.boardType, mq.gsm))
    if (!hasStock) criticalPoIds.add(li.poId)
  }

  let sumThis = 0
  let nThis = 0
  let sumPrev = 0
  let nPrev = 0
  for (const row of vendorLinesPrice) {
    const r = row.ratePerKg != null ? Number(row.ratePerKg) : NaN
    if (!Number.isFinite(r) || r <= 0) continue
    const dt = row.vendorPo.orderDate ?? row.vendorPo.createdAt
    if (dt >= monthStart) {
      sumThis += r
      nThis++
    } else if (dt >= prevMonthStart && dt < monthStart) {
      sumPrev += r
      nPrev++
    }
  }
  const avgThis = nThis ? sumThis / nThis : null
  const avgPrev = nPrev ? sumPrev / nPrev : null
  let priceVariancePct: number | null = null
  if (avgThis != null && avgPrev != null && avgPrev > 0) {
    priceVariancePct = Math.round(((avgThis - avgPrev) / avgPrev) * 1000) / 10
  }

  let monthlyWeightLossInr = 0
  for (const w of weightReconsMtd) {
    monthlyWeightLossInr += monthlyWeightLossValueInr(
      Number(w.varianceKg),
      w.ratePerKgInr != null ? Number(w.ratePerKgInr) : null,
    )
  }

  return {
    openMaterialSpendInr,
    incomingBoardKg7d,
    criticalShortagePoCount: criticalPoIds.size,
    priceVariancePct,
    monthlyWeightLossInr,
  }
}
