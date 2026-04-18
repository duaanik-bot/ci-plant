import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const schema = z.object({
  lanes: z.array(
    z.object({
      machineId: z.string().uuid(),
      orderedLineIds: z.array(z.string().uuid()),
      projectedFinishes: z.record(z.string(), z.string()).optional(),
    }),
  ),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const { lanes } = parsed.data

  await db.$transaction(async (tx) => {
    for (const lane of lanes) {
      for (let i = 0; i < lane.orderedLineIds.length; i++) {
        const lineId = lane.orderedLineIds[i]
        const existing = await tx.poLineItem.findUnique({ where: { id: lineId } })
        if (!existing) continue
        const spec = {
          ...((existing.specOverrides as Record<string, unknown> | null) ?? {}),
          planningGanttMachineId: lane.machineId,
          planningGanttIndex: i,
          planningProjectedFinishAt: lane.projectedFinishes?.[lineId] ?? null,
        }
        await tx.poLineItem.update({
          where: { id: lineId },
          data: { specOverrides: spec as object },
        })
      }
    }
  })

  const firstLineId = lanes[0]?.orderedLineIds[0]
  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'planning_gantt',
    recordId: firstLineId,
    newValue: { lanes: lanes.length, lineCount: lanes.reduce((n, l) => n + l.orderedLineIds.length, 0) },
  })

  return NextResponse.json({ ok: true })
}
