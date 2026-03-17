import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Returns job cards that have at least one stage ready or in_progress, for shopfloor tablet.
 */
export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const list = await db.productionJobCard.findMany({
    where: {
      status: { in: ['design_ready', 'in_progress'] },
    },
    orderBy: { jobCardNumber: 'desc' },
    include: {
      customer: { select: { id: true, name: true } },
      stages: { orderBy: { createdAt: 'asc' } },
    },
  })

  return NextResponse.json(list)
}
