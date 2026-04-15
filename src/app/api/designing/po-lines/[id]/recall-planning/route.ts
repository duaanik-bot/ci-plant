import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { PLANNING_FLOW, readOrchestration } from '@/lib/orchestration-spec'

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
  const orch = readOrchestration(base)
  const nextOrch = { ...orch, planningFlowStatus: PLANNING_FLOW.idle }
  delete nextOrch.planningForwardedAt
  base.orchestration = nextOrch

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
