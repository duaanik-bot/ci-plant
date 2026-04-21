import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { PLANNING_FLOW, readOrchestration } from '@/lib/orchestration-spec'
import { releaseReservedToolingForPoLine } from '@/lib/aw-queue-release-tooling'

export const dynamic = 'force-dynamic'

function stripAwHandoff(spec: Record<string, unknown>) {
  const orch = readOrchestration(spec)
  const next = {
    ...orch,
    planningFlowStatus: PLANNING_FLOW.idle,
  }
  delete next.awQueueHandoffAt
  delete next.planningForwardedAt
  return { ...spec, orchestration: next }
}

/** Pull a line back from AW queue to pending planning (reverse of Make Processing). */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const line = await db.poLineItem.findUnique({ where: { id } })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const blocked = new Set(['in_production', 'closed'])
  if (blocked.has(line.planningStatus)) {
    return NextResponse.json(
      { error: 'Cannot recall: line is in production or closed' },
      { status: 409 },
    )
  }

  if (line.planningStatus === 'pending') {
    return NextResponse.json({ error: 'Line is already pending in planning' }, { status: 409 })
  }

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const base = stripAwHandoff({ ...spec }) as Record<string, unknown>
  delete base.planningMakeProcessingAt
  delete base.planningMakeProcessingBy

  const actorName = user!.name ?? user!.email ?? 'planner'

  const updated = await db.$transaction(async (tx) => {
    await releaseReservedToolingForPoLine(tx, {
      poLineItemId: id,
      actorName,
      reason: 'Planning recall from AW queue',
    })
    return tx.poLineItem.update({
      where: { id },
      data: {
        planningStatus: 'pending',
        specOverrides: base as object,
      },
    })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: id,
    newValue: { recallFromAw: true },
  })

  return NextResponse.json(updated)
}
