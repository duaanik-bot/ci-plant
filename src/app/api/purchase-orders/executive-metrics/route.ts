import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

function poLineValueSum(lineItems: { rate: unknown; quantity: number }[]): number {
  return lineItems.reduce((s, li) => s + (li.rate ? Number(li.rate) : 0) * li.quantity, 0)
}

/** Calendar days from PO date (local midnight) to today (local midnight). */
function ageDaysFromPoDate(poDate: Date): number {
  const start = new Date(poDate.getFullYear(), poDate.getMonth(), poDate.getDate())
  const t = new Date()
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate())
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000))
}

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  /** Command-center KPIs: confirmed pipeline only (excludes drafts & closed). */
  const confirmedPos = await db.purchaseOrder.findMany({
    where: { status: 'confirmed' },
    include: { lineItems: true },
  })

  const totalActivePosCount = confirmedPos.length
  const pendingItemsSum = confirmedPos.reduce(
    (sum, po) => sum + po.lineItems.reduce((s, li) => s + li.quantity, 0),
    0,
  )
  const liveOrderValue = confirmedPos.reduce((sum, po) => sum + poLineValueSum(po.lineItems), 0)

  const avgAgingDaysActive =
    totalActivePosCount > 0
      ? confirmedPos.reduce((sum, po) => sum + ageDaysFromPoDate(po.poDate), 0) / totalActivePosCount
      : 0

  return NextResponse.json({
    totalActivePosCount,
    pendingItemsSum,
    liveOrderValue,
    avgAgingDaysActive,
  })
}
