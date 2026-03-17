import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const ACTIVE_STATUSES = ['artwork_approved', 'in_production', 'folding', 'final_qc', 'packing']

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const jobs = await db.job.findMany({
    where: { status: { in: ACTIVE_STATUSES } },
    select: {
      id: true,
      jobNumber: true,
      productName: true,
      status: true,
      customer: { select: { name: true } },
    },
    orderBy: { dueDate: 'asc' },
  })

  return NextResponse.json(jobs)
}
