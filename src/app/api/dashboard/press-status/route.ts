import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { calculateOEE } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const presses = await db.machine.findMany({
    where: { machineCode: { in: ['CI-01', 'CI-02', 'CI-03'] } },
    orderBy: { machineCode: 'asc' },
  })
  const today = new Date()

  const result = await Promise.all(
    presses.map(async (press) => {
      const oee = await calculateOEE(press.id, today)
      const activeStage = await db.jobStage.findFirst({
        where: { machineId: press.id, completedAt: null },
        include: { job: { select: { jobNumber: true, productName: true } } },
      })

      return {
        machineCode: press.machineCode,
        machineName: press.name,
        status: press.status,
        job: activeStage?.job ?? null,
        oee: oee.oee,
        sheets: oee.totalSheets ?? 0,
        firstArticleStatus: null as string | null,
      }
    })
  )

  return NextResponse.json(result)
}

