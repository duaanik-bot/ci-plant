import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { mergeOrchestrationIntoSpec, PLATE_FLOW } from '@/lib/orchestration-spec'

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
          newValue: { sendBackTriage: true } as object,
        },
      })
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
