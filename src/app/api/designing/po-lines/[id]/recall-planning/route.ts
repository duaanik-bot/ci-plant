import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { PLANNING_FLOW, readOrchestration } from '@/lib/orchestration-spec'

/** Clears orchestration handoff timestamps so AW queue can re-sync after facts are cleared. */
function stripPlanningHandoffOrch(spec: Record<string, unknown>) {
  const prev = readOrchestration(spec)
  const next = { ...prev, planningFlowStatus: PLANNING_FLOW.idle }
  delete next.planningForwardedAt
  delete next.awQueueHandoffAt
  return next
}

export const dynamic = 'force-dynamic'

/** POST — Pull line back from planning if execution has not started (no machine allocation). */
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
      { error: 'Cannot recall: line is already in production or closed' },
      { status: 409 },
    )
  }

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  if (String(spec.machineId || '').trim()) {
    return NextResponse.json(
      { error: 'Cannot recall: machine is already allocated — clear machine in Planning first' },
      { status: 409 },
    )
  }

  const base = { ...spec }
  delete base.planningCore
  delete base.planningDesignerDisplayName
  base.orchestration = stripPlanningHandoffOrch(base)

  const backStatus = line.jobCardNumber != null ? 'job_card_created' : 'design_ready'

  const updated = await db.poLineItem.update({
    where: { id },
    data: {
      planningStatus: backStatus,
      specOverrides: base as object,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: id,
    newValue: { recallPlanning: true },
  })

  return NextResponse.json(updated)
}
