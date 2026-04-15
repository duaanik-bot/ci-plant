import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { mergeOrchestrationIntoSpec, PLATE_FLOW } from '@/lib/orchestration-spec'
import {
  createPlateHubEvent,
  HUB_ZONE,
  PLATE_HUB_ACTION,
} from '@/lib/plate-hub-events'

export const dynamic = 'force-dynamic'

/** POST — Move a job from CTP internal queue back to incoming triage. */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const reqRow = await db.plateRequirement.findUnique({ where: { id } })
  if (!reqRow) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })

  if (reqRow.status !== 'ctp_internal_queue' || reqRow.triageChannel !== 'inhouse_ctp') {
    return NextResponse.json(
      { error: 'Only in-house CTP queue items can be sent back to triage' },
      { status: 409 },
    )
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.plateRequirement.update({
        where: { id },
        data: {
          triageChannel: null,
          status: 'pending',
          ctpTriggeredAt: null,
          ctpOperator: null,
          lastStatusUpdatedAt: new Date(),
        },
      })

      const poLineId = reqRow.poLineId?.trim()
      if (poLineId) {
        const line = await tx.poLineItem.findUnique({
          where: { id: poLineId },
          select: { specOverrides: true },
        })
        if (line) {
          const spec = (line.specOverrides as Record<string, unknown> | null) || {}
          await tx.poLineItem.update({
            where: { id: poLineId },
            data: {
              specOverrides: mergeOrchestrationIntoSpec(spec, {
                plateFlowStatus: PLATE_FLOW.triage,
              }) as object,
            },
          })
        }
      }

      await tx.auditLog.create({
        data: {
          userId: user!.id,
          action: 'UPDATE',
          tableName: 'plate_requirements',
          recordId: id,
          newValue: { sendBackTriage: true } as object,
        },
      })

      await createPlateHubEvent(tx, {
        plateRequirementId: id,
        actionType: PLATE_HUB_ACTION.SEND_BACK_TRIAGE,
        fromZone: HUB_ZONE.CTP_QUEUE,
        toZone: HUB_ZONE.INCOMING_TRIAGE,
        details: { requirementCode: reqRow.requirementCode },
      })
    })
  } catch (e) {
    console.error('[plate-requirements/send-back-triage]', e)
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2025') {
        return NextResponse.json(
          { error: 'Failed to revert: a linked PO line or record is missing.' },
          { status: 409 },
        )
      }
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
