import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

function isTrialMode() {
  return process.env.CI_TRIAL_MODE === '1' || process.env.NODE_ENV !== 'production'
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  if (!isTrialMode()) {
    return NextResponse.json({ error: 'Clear queue is allowed in trial mode only' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({})) as { confirm?: boolean }
  if (!body.confirm) {
    return NextResponse.json({ error: 'Confirmation required' }, { status: 400 })
  }

  const candidates = await db.productionJobCard.findMany({
    where: {
      status: { in: ['design_ready', 'pending', 'draft'] },
      qaReleased: false,
    },
    select: {
      id: true,
      jobCardNumber: true,
      status: true,
    },
  })

  const testTagged = await db.productionJobCard.findMany({
    where: {
      qaReleased: false,
      status: { notIn: ['in_progress', 'final_qc', 'qa_released', 'closed'] },
      OR: [
        { batchNumber: { contains: 'test', mode: 'insensitive' } },
        { batchNumber: { contains: 'trial', mode: 'insensitive' } },
      ],
    },
    select: { id: true, jobCardNumber: true, status: true },
  })

  const map = new Map<string, { id: string; jobCardNumber: number; status: string }>()
  for (const row of [...candidates, ...testTagged]) map.set(row.id, row)
  const clearable = Array.from(map.values())

  if (clearable.length === 0) {
    return NextResponse.json({ success: true, cleared: 0, clearedIds: [] })
  }

  const clearIds = clearable.map((r) => r.id)
  await db.$transaction(async (tx) => {
    await tx.productionJobCard.updateMany({
      where: { id: { in: clearIds } },
      data: { status: 'archived' },
    })
    await tx.poLineItem.updateMany({
      where: { jobCardNumber: { in: clearable.map((r) => r.jobCardNumber) } },
      data: { jobCardNumber: null },
    })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'production_job_cards',
    recordId: 'bulk',
    newValue: {
      mode: 'trial_clear_queue',
      clearedIds: clearIds,
      clearedJobCardNumbers: clearable.map((r) => r.jobCardNumber),
      clearedStatuses: clearable.map((r) => r.status),
    },
  })

  return NextResponse.json({
    success: true,
    cleared: clearIds.length,
    clearedIds: clearIds,
    clearedJobCardNumbers: clearable.map((r) => r.jobCardNumber),
  })
}
