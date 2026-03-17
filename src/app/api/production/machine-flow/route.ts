import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { calculateOEE } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const machines = await db.machine.findMany({
    orderBy: { machineCode: 'asc' },
    select: { id: true, machineCode: true, name: true, status: true, capacityPerShift: true },
  })

  const today = new Date()
  const activeStages = await db.jobStage.findMany({
    where: { completedAt: null },
    include: {
      job: { select: { jobNumber: true, productName: true, qtyOrdered: true, qtyProducedGood: true } },
      machine: { select: { machineCode: true } },
    },
  })

  const stageByMachineId = new Map(activeStages.map((s) => [s.machineId ?? '', s]))

  const pressCodes = ['CI-01', 'CI-02', 'CI-03']
  const oeeByMachineId: Record<string, { oee: number; totalSheets?: number }> = {}
  for (const m of machines) {
    if (pressCodes.includes(m.machineCode)) {
      const oee = await calculateOEE(m.id, today)
      oeeByMachineId[m.id] = { oee: oee.oee, totalSheets: oee.totalSheets }
    }
  }

  const list = machines.map((m) => {
    const active = stageByMachineId.get(m.id)
    const oeeData = oeeByMachineId[m.id]
    return {
      id: m.id,
      machineCode: m.machineCode,
      name: m.name,
      status: m.status,
      capacityPerShift: m.capacityPerShift,
      currentJob: active?.job ? { jobNumber: active.job.jobNumber, productName: active.job.productName } : null,
      oee: oeeData?.oee ?? null,
      sheetsToday: oeeData?.totalSheets ?? null,
      firstArticle: null as string | null,
    }
  })

  return NextResponse.json(list)
}
