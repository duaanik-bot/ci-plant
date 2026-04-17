import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { mergeOrchestrationIntoSpec, PLANNING_FLOW } from '@/lib/orchestration-spec'
import { formatDimsLwhFromDb } from '@/lib/die-hub-dimensions'
import { masterDieTypeLabel } from '@/lib/master-die-type'

export const dynamic = 'force-dynamic'

/** POST — Forward line to planning in parallel with plate hub (does not require finalize). */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const line = await db.poLineItem.findUnique({
    where: { id },
    include: {
      dieMaster: {
        select: {
          id: true,
          dyeNumber: true,
          dyeType: true,
          pastingType: true,
          dimLengthMm: true,
          dimWidthMm: true,
          dimHeightMm: true,
        },
      },
    },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const approvalsComplete = !!(spec.customerApprovalPharma && spec.shadeCardQaTextApproval)
  if (!approvalsComplete) {
    return NextResponse.json(
      { error: 'Customer and QA approvals must be complete before forwarding to planning' },
      { status: 400 },
    )
  }

  const now = new Date().toISOString()
  const dm = line.dieMaster
  const dimsLwh =
    dm != null
      ? formatDimsLwhFromDb({
          dimLengthMm: dm.dimLengthMm as { toString(): string } | null,
          dimWidthMm: dm.dimWidthMm as { toString(): string } | null,
          dimHeightMm: dm.dimHeightMm as { toString(): string } | null,
        })
      : null
  const toolingBridge =
    line.dieMasterId && dm
      ? {
          dieMasterId: line.dieMasterId,
          masterDyeNumber: dm.dyeNumber,
          masterDieType: masterDieTypeLabel({ dyeType: dm.dyeType, pastingType: dm.pastingType }),
          dimensionsLwh: dimsLwh,
        }
      : line.dieMasterId
        ? { dieMasterId: line.dieMasterId }
        : null
  const nextSpec = mergeOrchestrationIntoSpec(spec, {
    planningFlowStatus: PLANNING_FLOW.forwarded,
    planningForwardedAt: now,
    ...(toolingBridge ? { toolingFromMaster: toolingBridge } : {}),
  })

  const updated = await db.poLineItem.update({
    where: { id },
    data: {
      planningStatus: 'planned',
      specOverrides: nextSpec as object,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: id,
    newValue: { forwardPlanning: true, planningForwardedAt: now },
  })

  return NextResponse.json(updated)
}
