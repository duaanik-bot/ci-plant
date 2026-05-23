import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { calculateOEE } from '@/lib/helpers'
import { PRESS_MACHINE_CODES } from '@/lib/master-data'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const [activeJobs, runningStages, pendingApprovals, upcomingDispatches] = await Promise.all([
    db.job.count({
      where: { status: { in: ['pending_artwork', 'artwork_approved', 'in_production', 'folding', 'final_qc', 'packing'] } },
    }),
    db.jobStage.count({ where: { completedAt: null } }),
    Promise.all([
      db.sheetIssue.count({ where: { isExcess: true, approvedAt: null, rejectedAt: null } }),
      // PO lines on open POs that are NOT yet artwork-locked. Substitute for the
      // old artwork_approvals count after the 4-lock workflow was retired.
      db.poLineItem.count({
        where: {
          po: { status: { notIn: ['closed', 'cancelled'] } },
          NOT: { specOverrides: { path: ['artworkLocked'], equals: true } },
        },
      }),
      db.purchaseRequisition.count({ where: { status: 'pending' } }),
    ]).then(([excess, artwork, pr]) => excess + artwork + pr),
    db.job.count({
      where: {
        status: { in: ['final_qc', 'packing'] },
      },
    }),
  ])

  const today = new Date()
  const presses = await db.machine.findMany({
    where: { machineCode: { in: PRESS_MACHINE_CODES } },
    select: { id: true },
  })
  let oeeSum = 0
  for (const p of presses) {
    const o = await calculateOEE(p.id, today)
    oeeSum += o.oee
  }
  const avgOee = presses.length ? Math.round((oeeSum / presses.length) * 10) / 10 : 0

  return NextResponse.json({
    activeJobs,
    runningPresses: runningStages,
    avgOee,
    pendingApprovals,
    dispatchDue: upcomingDispatches,
  })
}

