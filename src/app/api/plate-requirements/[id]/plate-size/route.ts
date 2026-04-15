import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { PlateSize } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  plateSize: z.nativeEnum(PlateSize),
})

/** Incoming triage only: set / override `plateSize` before CTP or vendor dispatch. */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body — send { plateSize: SIZE_560_670 | SIZE_630_700 }' },
      { status: 400 },
    )
  }

  const existing = await db.plateRequirement.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const inIncomingTriage =
    existing.triageChannel == null &&
    ['pending', 'ctp_notified', 'plates_ready'].includes(existing.status)

  if (!inIncomingTriage) {
    return NextResponse.json(
      { error: 'Plate size can only be changed while the job is in incoming triage.' },
      { status: 409 },
    )
  }

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.plateRequirement.update({
      where: { id },
      data: {
        plateSize: parsed.data.plateSize,
        lastStatusUpdatedAt: new Date(),
      },
    })
    await createPlateHubEvent(tx, {
      plateRequirementId: id,
      actionType: PLATE_HUB_ACTION.RESIZED,
      fromZone: HUB_ZONE.INCOMING_TRIAGE,
      toZone: HUB_ZONE.INCOMING_TRIAGE,
      details: {
        oldPlateSize: existing.plateSize,
        newPlateSize: parsed.data.plateSize,
        oldSize: existing.plateSize,
        newSize: parsed.data.plateSize,
        source: 'hub_triage_inline_size',
      },
    })
    return u
  })

  try {
    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'plate_requirements',
      recordId: id,
      newValue: { plateSize: parsed.data.plateSize, source: 'hub_triage_inline_size' },
    })
  } catch (e) {
    console.error('[plate-requirements/plate-size] audit', e)
  }

  return NextResponse.json({ ok: true, requirement: updated })
}
