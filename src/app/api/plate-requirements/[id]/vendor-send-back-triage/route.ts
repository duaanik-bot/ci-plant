import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { mergeOrchestrationIntoSpec, PLATE_FLOW } from '@/lib/orchestration-spec'

export const dynamic = 'force-dynamic'

/** POST — Return a job from outside-vendor queue to incoming triage (undo vendor path). */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const reqRow = await db.plateRequirement.findUnique({ where: { id } })
  if (!reqRow) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })

  if (reqRow.triageChannel !== 'outside_vendor') {
    return NextResponse.json(
      { error: 'Only outside-vendor queue items can use this action' },
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
        },
      })

      if (reqRow.poLineId?.trim()) {
        const line = await tx.poLineItem.findUnique({
          where: { id: reqRow.poLineId },
          select: { specOverrides: true },
        })
        const spec = (line?.specOverrides as Record<string, unknown> | null) || {}
        await tx.poLineItem.update({
          where: { id: reqRow.poLineId },
          data: {
            specOverrides: mergeOrchestrationIntoSpec(spec, {
              plateFlowStatus: PLATE_FLOW.triage,
            }) as object,
          },
        })
      }

      await tx.auditLog.create({
        data: {
          userId: user!.id,
          action: 'UPDATE',
          tableName: 'plate_requirements',
          recordId: id,
          newValue: { vendorSendBackTriage: true } as object,
        },
      })
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
