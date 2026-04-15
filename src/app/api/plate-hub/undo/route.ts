import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'
import { mergeOrchestrationIntoSpec, PLATE_FLOW } from '@/lib/orchestration-spec'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'

export const dynamic = 'force-dynamic'

const undoSchema = z.object({
  poLineId: z.string().uuid(),
})

/**
 * POST /api/plate-hub/undo
 * Reverses a Finalize Job action:
 *   - Clears prePressSentToPlateHubAt from specOverrides
 *   - Cancels the associated PlateRequirement (if any)
 */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = undoSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'poLineId (UUID) is required' }, { status: 400 })
  }

  const { poLineId } = parsed.data

  const line = await db.poLineItem.findUnique({
    where: { id: poLineId },
    select: { specOverrides: true },
  })

  if (!line) {
    return NextResponse.json({ error: 'PO line not found' }, { status: 404 })
  }

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}

  if (!spec.prePressSentToPlateHubAt) {
    return NextResponse.json({ error: 'Job has not been finalized yet' }, { status: 409 })
  }

  const requirementCode = spec.lastPlateRequirementCode as string | undefined

  // Build new spec without the finalized fields
  const { prePressSentToPlateHubAt: _removed, lastPlateRequirementCode: _rc, plateHubPayload: _ph, ...restSpec } = spec

  const toCancelRows =
    requirementCode ?
      await db.plateRequirement.findMany({
        where: { requirementCode, status: { not: 'cancelled' } },
        select: { id: true },
      })
    : []

  await db.$transaction(async (tx) => {
    // Clear finalize stamp from specOverrides
    await tx.poLineItem.update({
      where: { id: poLineId },
      data: {
        specOverrides: mergeOrchestrationIntoSpec(restSpec as Record<string, unknown>, {
          plateFlowStatus: PLATE_FLOW.idle,
        }) as object,
      },
    })

    // Cancel the plate requirement if one was created
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
        details: { poLineId, requirementCode: requirementCode ?? undefined },
      })
    }

    await tx.auditLog.create({
      data: {
        userId: user!.id,
        action: 'UPDATE',
        tableName: 'po_line_items',
        recordId: poLineId,
        newValue: {
          undoFinalize: true,
          cancelledRequirementCode: requirementCode ?? null,
        } as object,
      },
    })
  })

  return NextResponse.json({ ok: true, cancelledRequirementCode: requirementCode ?? null })
}
