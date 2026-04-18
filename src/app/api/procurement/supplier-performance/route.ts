import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Average calendar days dispatch ran past required delivery (0 if on-time), per supplier. */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const supplierId = req.nextUrl.searchParams.get('supplierId')?.trim() ?? ''
  if (!supplierId) {
    return NextResponse.json({ error: 'supplierId required' }, { status: 400 })
  }

  const pos = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      supplierId,
      dispatchedAt: { not: null },
      requiredDeliveryDate: { not: null },
    },
    select: {
      requiredDeliveryDate: true,
      dispatchedAt: true,
    },
    take: 80,
    orderBy: { dispatchedAt: 'desc' },
  })

  if (pos.length === 0) {
    return NextResponse.json({ avgDaysLate: null, sampleSize: 0 })
  }

  let sum = 0
  for (const p of pos) {
    const reqD = p.requiredDeliveryDate!
    const disp = p.dispatchedAt!
    const r = new Date(reqD.getFullYear(), reqD.getMonth(), reqD.getDate()).getTime()
    const d = new Date(disp.getFullYear(), disp.getMonth(), disp.getDate()).getTime()
    const lateDays = Math.max(0, (d - r) / 86_400_000)
    sum += lateDays
  }

  return NextResponse.json({
    avgDaysLate: Math.round((sum / pos.length) * 10) / 10,
    sampleSize: pos.length,
  })
}
