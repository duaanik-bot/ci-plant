import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { calculateOEE } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Public — no auth. For OEE TV dashboard. */
export async function GET() {
  const presses = await db.machine.findMany({
    where: { machineCode: { in: ['CI-01', 'CI-02', 'CI-03'] }, status: 'active' },
  })

  const today = new Date()
  const oeeData = await Promise.all(
    presses.map(async (press) => {
      const oee = await calculateOEE(press.id, today)
      const activeStage = await db.jobStage.findFirst({
        where: { machineId: press.id, completedAt: null },
        include: { job: { select: { jobNumber: true, productName: true, qtyOrdered: true } } },
      })
      return {
        machineCode: press.machineCode,
        machineName: press.name,
        ...oee,
        activeJob: activeStage?.job ?? null,
      }
    })
  )

  return NextResponse.json(oeeData, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}
