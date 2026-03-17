import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** GET ?machineId=xxx — active stage for this machine */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const machineId = searchParams.get('machineId')
  if (!machineId) {
    return NextResponse.json({ error: 'machineId required' }, { status: 400 })
  }

  const stage = await db.jobStage.findFirst({
    where: { machineId, completedAt: null },
    include: {
      job: {
        select: {
          id: true,
          jobNumber: true,
          productName: true,
          qtyOrdered: true,
          qtyProducedGood: true,
        },
      },
      machine: { select: { machineCode: true, name: true } },
    },
  })

  if (!stage) return NextResponse.json({ active: null })
  return NextResponse.json({ active: stage })
}
