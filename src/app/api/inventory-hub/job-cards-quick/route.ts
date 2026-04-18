import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Lightweight job card picker for shade issue (search by # or customer name). */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const num = parseInt(q, 10)
  const hasNum = q.length > 0 && !Number.isNaN(num) && String(num) === q

  const list = await db.productionJobCard.findMany({
    where:
      q.length === 0
        ? undefined
        : {
            OR: [
              ...(hasNum ? [{ jobCardNumber: num }] : []),
              { customer: { name: { contains: q, mode: 'insensitive' as const } } },
            ],
          },
    take: 25,
    orderBy: { jobCardNumber: 'desc' },
    select: {
      id: true,
      jobCardNumber: true,
      status: true,
      customer: { select: { name: true } },
    },
  })

  return NextResponse.json({ rows: list })
}
