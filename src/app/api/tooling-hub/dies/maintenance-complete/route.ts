import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { dieHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  dyeId: z.string().uuid(),
  actorName: z.string().min(1).max(120).optional(),
})

export async function POST(req: NextRequest) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: 'dyeId required' }, { status: 400 })
    }

    const { dyeId, actorName: actorRaw } = parsed.data
    const actor = actorRaw?.trim() || user?.name?.trim() || 'Operator'
    const now = new Date()

    const row = await db.dye.findFirst({
      where: { id: dyeId, active: true },
    })
    if (!row) return NextResponse.json({ error: 'Die not found' }, { status: 404 })

    const isPoor = row.condition?.trim() === 'Poor' || row.conditionRating?.trim() === 'Poor'
    if (!isPoor) {
      return NextResponse.json({ error: 'Maintenance complete is only for Poor condition dies' }, { status: 409 })
    }

    const fromZone = dieHubZoneLabelFromCustody(row.custodyStatus)

    await db.$transaction(async (tx) => {
      await tx.dye.update({
        where: { id: dyeId },
        data: {
          condition: 'Good',
          conditionRating: 'Good',
          hubMaintenanceCompletedAt: now,
          hubStatusFlag: null,
          hubPoorReportedBy: null,
          updatedAt: now,
        },
      })
      await createDieHubEvent(tx, {
        dyeId,
        actionType: DIE_HUB_ACTION.MAINTENANCE_COMPLETE,
        fromZone,
        toZone: fromZone,
        operatorName: actor,
        actorName: actor,
        eventCondition: 'Good',
        metadata: {
          condition: 'Good',
          remarks: 'Maintenance complete — reset from Poor',
        },
        details: {
          displayCode: `DYE-${row.dyeNumber}`,
          clearedByUserId: user?.id,
          clearedByName: actor,
          completedAt: now.toISOString(),
        },
      })
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'dyes',
      recordId: dyeId,
      newValue: { hubMaintenanceComplete: true } as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[tooling-hub/dies/maintenance-complete]', e)
    return NextResponse.json({ error: 'Maintenance update failed' }, { status: 500 })
  }
}
