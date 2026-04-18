import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { numFromDecimal, toMachinePmHealthRow } from '@/lib/machine-pm-health'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const machine = await db.machine.findUnique({
    where: { id },
    select: {
      id: true,
      machineCode: true,
      name: true,
      usageRunHoursSincePm: true,
      usageImpressionsSincePm: true,
      pmSchedule: {
        select: {
          intervalRunHours: true,
          intervalImpressions: true,
          taskChecklistJson: true,
          sparePartsPlaceholder: true,
        },
      },
    },
  })
  if (!machine) {
    return NextResponse.json({ error: 'Machine not found' }, { status: 404 })
  }

  const history = await db.preventiveMaintenanceLog.findMany({
    where: { machineId: id },
    orderBy: { verifiedAt: 'desc' },
    take: 3,
    select: {
      verifiedAt: true,
      signedOffNote: true,
      runHoursBeforeReset: true,
      impressionsBeforeReset: true,
    },
  })

  const healthRow = toMachinePmHealthRow(machine)
  let checklist: string[] = []
  const raw = machine.pmSchedule?.taskChecklistJson
  if (Array.isArray(raw)) {
    checklist = raw.filter((x): x is string => typeof x === 'string')
  }

  return NextResponse.json({
    machine: { id: machine.id, machineCode: machine.machineCode, name: machine.name },
    health: {
      healthPct: healthRow.healthPct,
      hourHealth: healthRow.hourHealth,
      impressionHealth: healthRow.impressionHealth,
      overdue: healthRow.overdue,
      hasSchedule: healthRow.hasSchedule,
    },
    usageRunHours: healthRow.usageRunHours,
    usageImpressions: healthRow.usageImpressions,
    intervalRunHours: healthRow.intervalRunHours,
    intervalImpressions: healthRow.intervalImpressions,
    serviceHistory: history.map((h) => ({
      verifiedAt: h.verifiedAt.toISOString(),
      signedOffNote: h.signedOffNote,
      runHoursBeforeReset: numFromDecimal(h.runHoursBeforeReset),
      impressionsBeforeReset: h.impressionsBeforeReset.toString(),
    })),
    checklist,
    sparePartsPlaceholder: machine.pmSchedule?.sparePartsPlaceholder ?? null,
  })
}
