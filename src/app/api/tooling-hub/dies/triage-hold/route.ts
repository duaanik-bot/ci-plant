import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { CUSTODY_HUB_TRIAGE } from '@/lib/inventory-hub-custody'
import { createDieHubEvent, DIE_HUB_ACTION } from '@/lib/die-hub-events'
import { dieHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  dyeId: z.string().uuid(),
  onHold: z.boolean(),
  reason: z.string().max(500).optional().nullable(),
  actorName: z.string().min(1).max(120).optional(),
})

export async function POST(req: NextRequest) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const { dyeId, onHold, reason, actorName: actorRaw } = parsed.data
    const now = new Date()
    const reasonTrim = reason?.trim() || null

    const row = await db.dye.findFirst({
      where: { id: dyeId, active: true, custodyStatus: CUSTODY_HUB_TRIAGE },
    })
    if (!row) {
      return NextResponse.json({ error: 'Die not in triage' }, { status: 404 })
    }

    if (onHold && !reasonTrim) {
      return NextResponse.json({ error: 'Hold reason is required' }, { status: 400 })
    }

    await db.$transaction(async (tx) => {
      await tx.dye.update({
        where: { id: dyeId },
        data: {
          hubTriageHoldReason: onHold ? reasonTrim : null,
          updatedAt: now,
        },
      })
      const actor = actorRaw?.trim() || user?.name?.trim() || 'Operator'
      await createDieHubEvent(tx, {
        dyeId,
        actionType: onHold ? DIE_HUB_ACTION.TRIAGE_ON_HOLD : DIE_HUB_ACTION.TRIAGE_HOLD_RELEASED,
        fromZone: dieHubZoneLabelFromCustody(CUSTODY_HUB_TRIAGE),
        toZone: dieHubZoneLabelFromCustody(CUSTODY_HUB_TRIAGE),
        operatorName: actor,
        actorName: actor,
        metadata: onHold && reasonTrim ? { remarks: reasonTrim } : undefined,
        details: {
          displayCode: `DYE-${row.dyeNumber}`,
          onHold,
          reason: onHold ? reasonTrim : undefined,
        },
      })
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'dyes',
      recordId: dyeId,
      newValue: { triageHold: onHold, reason: reasonTrim } as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[tooling-hub/dies/triage-hold]', e)
    return NextResponse.json({ error: 'Hold update failed' }, { status: 500 })
  }
}
