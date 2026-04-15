import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { mergeOrchestrationIntoSpec, PLATE_FLOW } from '@/lib/orchestration-spec'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'

export const dynamic = 'force-dynamic'

const RECALLABLE = new Set(['pending', 'ctp_notified'])

/**
 * POST — Recall from Plate Hub triage back to designer queue.
 * Blocks once work has left triage (CTP queue, vendor, or burning complete).
 */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const reqRow = await db.plateRequirement.findUnique({ where: { id } })
  if (!reqRow) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })

  if (reqRow.status === 'cancelled') {
    return NextResponse.json({ error: 'Requirement already cancelled' }, { status: 409 })
  }
  if (reqRow.status === 'plates_ready' || reqRow.status === 'ctp_internal_queue') {
    return NextResponse.json(
      { error: 'Cannot recall: plates already in CTP or marked ready. Use Send back to Triage from CTP if applicable.' },
      { status: 409 },
    )
  }
  if (!RECALLABLE.has(reqRow.status)) {
    return NextResponse.json(
      { error: `Cannot recall from status "${reqRow.status}"` },
      { status: 409 },
    )
  }
  if (reqRow.triageChannel != null) {
    return NextResponse.json(
      { error: 'Clear triage channel before recall, or use vendor/CTP-specific reversal.' },
      { status: 409 },
    )
  }

  const poLineId = reqRow.poLineId?.trim()
  if (!poLineId) {
    return NextResponse.json({ error: 'Requirement has no PO line link' }, { status: 409 })
  }

  const line = await db.poLineItem.findUnique({
    where: { id: poLineId },
    select: { specOverrides: true },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const {
    prePressSentToPlateHubAt: _a,
    lastPlateRequirementCode: _b,
    plateHubPayload: _c,
    ...restSpec
  } = spec

  try {
    await db.$transaction(async (tx) => {
      await tx.plateRequirement.update({
        where: { id },
        data: { status: 'cancelled' },
      })

      await tx.poLineItem.update({
        where: { id: poLineId },
        data: {
          specOverrides: mergeOrchestrationIntoSpec(
            restSpec as Record<string, unknown>,
            {
              plateFlowStatus: PLATE_FLOW.idle,
            },
          ) as object,
        },
      })

      await tx.auditLog.create({
        data: {
          userId: user!.id,
          action: 'UPDATE',
          tableName: 'plate_requirements',
          recordId: id,
          newValue: {
            recallPrePress: true,
            poLineId,
            requirementCode: reqRow.requirementCode,
          } as object,
        },
      })

      await createPlateHubEvent(tx, {
        plateRequirementId: id,
        actionType: PLATE_HUB_ACTION.RECALL_PREPRESS,
        fromZone: HUB_ZONE.INCOMING_TRIAGE,
        toZone: HUB_ZONE.CANCELLED,
        details: { poLineId, requirementCode: reqRow.requirementCode },
      })
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
