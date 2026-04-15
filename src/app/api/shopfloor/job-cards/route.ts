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

  const jobCardNumbers = list.map((j) => j.jobCardNumber).filter((n): n is number => n != null)
  const poLines =
    jobCardNumbers.length > 0
      ? await db.poLineItem.findMany({
          where: { jobCardNumber: { in: jobCardNumbers } },
          select: { jobCardNumber: true, cartonName: true },
        })
      : []
  const productNameByJc = new Map<number, string>()
  poLines.forEach((l) => {
    if (l.jobCardNumber != null) productNameByJc.set(l.jobCardNumber, l.cartonName)
  })

  const mapped = list.map((jc) => ({
    ...jc,
    productName: jc.jobCardNumber != null ? productNameByJc.get(jc.jobCardNumber) ?? null : null,
  }))

  return NextResponse.json(mapped)
}
