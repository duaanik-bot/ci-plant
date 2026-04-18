import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  boardGradesMatch,
  computeMarketBenchmark30d,
  computePriceTrend6m,
  normalizeBoardKey,
  priceVariancePct,
} from '@/lib/procurement-price-benchmark'

export const dynamic = 'force-dynamic'

/** Last purchase rates + 30d global benchmark + 6m trend for board grade + GSM. */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const boardGrade = req.nextUrl.searchParams.get('boardGrade')?.trim() ?? ''
  const gsmRaw = req.nextUrl.searchParams.get('gsm')?.trim() ?? ''
  const gsm = parseInt(gsmRaw, 10)
  if (!boardGrade || !Number.isFinite(gsm) || gsm <= 0) {
    return NextResponse.json({ error: 'boardGrade and gsm required' }, { status: 400 })
  }

  const currentRateRaw = req.nextUrl.searchParams.get('currentRatePerKg')
  const currentRate =
    currentRateRaw != null && currentRateRaw !== '' ? Number(currentRateRaw) : null

  const norm = normalizeBoardKey(boardGrade)
  const lines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: {
      gsm,
      ratePerKg: { not: null },
      vendorPo: { dispatchedAt: { not: null } },
    },
    orderBy: { vendorPo: { dispatchedAt: 'desc' } },
    take: 48,
    select: {
      id: true,
      boardGrade: true,
      ratePerKg: true,
      totalWeightKg: true,
      vendorPo: {
        select: {
          poNumber: true,
          dispatchedAt: true,
          supplier: { select: { name: true } },
        },
      },
    },
  })

  const matched = lines.filter((ln) => boardGradesMatch(ln.boardGrade, norm))
  const history = matched.slice(0, 3).map((ln) => ({
    ratePerKg: ln.ratePerKg != null ? Number(ln.ratePerKg) : null,
    poNumber: ln.vendorPo.poNumber,
    supplierName: ln.vendorPo.supplier.name,
    dispatchedAt: ln.vendorPo.dispatchedAt?.toISOString() ?? null,
    kg: Number(ln.totalWeightKg),
  }))

  const lastRate = history.find((h) => h.ratePerKg != null && h.ratePerKg > 0)?.ratePerKg ?? null

  const [benchmark30d, trend] = await Promise.all([
    computeMarketBenchmark30d(db, boardGrade, gsm),
    computePriceTrend6m(db, boardGrade, gsm),
  ])

  let variancePct: number | null = null
  if (
    benchmark30d != null &&
    currentRate != null &&
    Number.isFinite(currentRate) &&
    currentRate > 0
  ) {
    variancePct = Math.round(priceVariancePct(currentRate, benchmark30d.ratePerKg) * 100) / 100
  }

  return NextResponse.json({
    history,
    lastPurchaseRate: lastRate,
    benchmark30d,
    trend6m: trend.months,
    trendTooltip: {
      high: trend.seriesHigh > 0 ? trend.seriesHigh : null,
      low: trend.seriesLow > 0 ? trend.seriesLow : null,
      lastPaid: trend.lastPaid,
    },
    variancePct,
  })
}
