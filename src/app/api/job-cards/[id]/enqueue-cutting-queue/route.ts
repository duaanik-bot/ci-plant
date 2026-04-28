import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Marks the PO line for the cutting queue and optionally bumps Cutting stage to ready. */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const jc = await db.productionJobCard.findUnique({
    where: { id },
    include: { stages: true },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const line = await db.poLineItem.findFirst({
    where: { jobCardNumber: jc.jobCardNumber },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found for job card' }, { status: 404 })

  const prev =
    line.specOverrides && typeof line.specOverrides === 'object'
      ? ({ ...line.specOverrides } as Record<string, unknown>)
      : {}
  const eoRaw = prev.executionOrchestration
  const eo =
    eoRaw && typeof eoRaw === 'object' ? ({ ...eoRaw } as Record<string, unknown>) : ({} as Record<string, unknown>)

  if (typeof eo.cuttingQueueEnqueuedAt === 'string' && eo.cuttingQueueEnqueuedAt.length > 0) {
    return NextResponse.json({ ok: true as const, idempotent: true as const })
  }

  const now = new Date().toISOString()
  const nextSpec = {
    ...prev,
    executionOrchestration: {
      ...eo,
      cuttingQueueEnqueuedAt: now,
      cuttingQueueEnqueuedByUserId: user!.id,
    },
  }

  await db.$transaction(async (tx) => {
    await tx.poLineItem.update({
      where: { id: line.id },
      data: { specOverrides: nextSpec as object },
    })
    const cutting = jc.stages.find((s) => s.stageName === 'Cutting')
    if (cutting && cutting.status === 'pending') {
      await tx.productionStageRecord.update({
        where: { id: cutting.id },
        data: { status: 'ready' },
      })
    }
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: line.id,
    newValue: {
      cuttingQueueEnqueuedAt: now,
      productionJobCardId: jc.id,
      jobCardNumber: jc.jobCardNumber,
    },
  })

  return NextResponse.json({ ok: true as const })
}
