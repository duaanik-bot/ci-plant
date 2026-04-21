import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { z } from 'zod'
import {
  mergeOrchestrationIntoSpec,
  PLATE_FLOW,
  PLANNING_FLOW,
  readOrchestration,
} from '@/lib/orchestration-spec'
import { releaseReservedToolingForPoLine } from '@/lib/aw-queue-release-tooling'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'
import { parseDesignerCommand } from '@/lib/designer-command'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  poLineId: z.string().uuid(),
})

/**
 * POST /api/designing/po-lines/[id]/recall-job
 * Full “recall” after Plate Hub send: reverses finalize (same as plate-hub/undo) and
 * resets hub handshake + tooling dispatch intents on the line to draft.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id: routeId } = await context.params

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'poLineId (UUID) is required' }, { status: 400 })
  }

  const { poLineId } = parsed.data
  if (poLineId !== routeId) {
    return NextResponse.json({ error: 'poLineId must match route id' }, { status: 400 })
  }

  const line = await db.poLineItem.findUnique({
    where: { id: poLineId },
    select: { specOverrides: true },
  })

  if (!line) {
    return NextResponse.json({ error: 'PO line not found' }, { status: 404 })
  }

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}

  if (!spec.prePressSentToPlateHubAt) {
    return NextResponse.json({ error: 'Job has not been sent to Plate Hub yet' }, { status: 409 })
  }

  const requirementCode = spec.lastPlateRequirementCode as string | undefined

  const { prePressSentToPlateHubAt: _r1, lastPlateRequirementCode: _r2, plateHubPayload: _r3, ...restSpec } = spec

  const dc = parseDesignerCommand(spec.designerCommand)
  const designerCommandDraft = {
    ...dc,
    dieLastIntent: null,
    embossLastIntent: null,
    dieLastIntentAt: undefined as string | undefined,
    embossLastIntentAt: undefined as string | undefined,
    plateHubDispatchAt: undefined as string | undefined,
  }

  let mergedSpec: Record<string, unknown> = {
    ...restSpec,
    designerCommand: designerCommandDraft,
    smartHandshake: {},
  }
  const orchPrev = readOrchestration(mergedSpec)
  const orchNext = { ...orchPrev, planningForwardedAt: undefined as string | undefined }
  delete orchNext.planningForwardedAt
  mergedSpec = mergeOrchestrationIntoSpec(
    { ...mergedSpec, orchestration: orchNext },
    {
      plateFlowStatus: PLATE_FLOW.idle,
      planningFlowStatus: PLANNING_FLOW.idle,
    },
  )

  const toCancelRows =
    requirementCode ?
      await db.plateRequirement.findMany({
        where: { requirementCode, status: { not: 'cancelled' } },
        select: { id: true },
      })
    : []

  await db.$transaction(async (tx) => {
    await releaseReservedToolingForPoLine(tx, {
      poLineItemId: poLineId,
      actorName: user!.name?.trim() || 'Operator',
      reason: 'recall_job',
    })
    await tx.poLineItem.update({
      where: { id: poLineId },
      data: {
        specOverrides: mergedSpec as object,
      },
    })

    if (requirementCode) {
      await tx.plateRequirement.updateMany({
        where: { requirementCode, status: { not: 'cancelled' } },
        data: { status: 'cancelled' },
      })
    }

    for (const row of toCancelRows) {
      await createPlateHubEvent(tx, {
        plateRequirementId: row.id,
        actionType: PLATE_HUB_ACTION.UNDO_FINALIZE,
        fromZone: HUB_ZONE.OTHER,
        toZone: HUB_ZONE.CANCELLED,
        details: { poLineId, requirementCode: requirementCode ?? undefined, recallJob: true },
      })
    }

    await tx.auditLog.create({
      data: {
        userId: user!.id,
        action: 'UPDATE',
        tableName: 'po_line_items',
        recordId: poLineId,
        newValue: {
          recallJob: true,
          cancelledRequirementCode: requirementCode ?? null,
        } as object,
      },
    })
  })

  return NextResponse.json({ ok: true, cancelledRequirementCode: requirementCode ?? null })
}
