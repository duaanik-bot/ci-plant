import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const items = await db.inventory.findMany({
    where: { reorderPoint: { gt: 0 } },
    orderBy: { materialCode: 'asc' },
  })

  const alerts = items.filter(
    (i) =>
      Number(i.qtyAvailable) + Number(i.qtyQuarantine) <= Number(i.reorderPoint)
  )

  return NextResponse.json(alerts)
}
