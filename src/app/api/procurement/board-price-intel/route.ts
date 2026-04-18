import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Last purchase rates for a board grade + GSM (dispatched / historical vendor lines). */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const boardGrade = req.nextUrl.searchParams.get('boardGrade')?.trim() ?? ''
  const gsmRaw = req.nextUrl.searchParams.get('gsm')?.trim() ?? ''
  const gsm = parseInt(gsmRaw, 10)
  if (!boardGrade || !Number.isFinite(gsm) || gsm <= 0) {
    return NextResponse.json({ error: 'boardGrade and gsm required' }, { status: 400 })
  }

  const norm = boardGrade.trim().toLowerCase()
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

  const matched = lines.filter((ln) => {
    const g = ln.boardGrade.trim().toLowerCase()
    return g === norm || g.includes(norm) || norm.includes(g)
  })
  const history = matched.slice(0, 3).map((ln) => ({
    ratePerKg: ln.ratePerKg != null ? Number(ln.ratePerKg) : null,
    poNumber: ln.vendorPo.poNumber,
    supplierName: ln.vendorPo.supplier.name,
    dispatchedAt: ln.vendorPo.dispatchedAt?.toISOString() ?? null,
    kg: Number(ln.totalWeightKg),
  }))

  const lastRate = history.find((h) => h.ratePerKg != null && h.ratePerKg > 0)?.ratePerKg ?? null

  return NextResponse.json({ history, lastPurchaseRate: lastRate })
}
