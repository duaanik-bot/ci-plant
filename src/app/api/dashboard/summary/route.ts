import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { calculateOEE } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const today = new Date()

  const [
    activeJobs,
    runningStages,
    pendingCounts,
    dispatchDue,
    presses,
    alertsData,
    pipelineJobs,
    rfqList,
    inventoryItems,
    jobsList,
    openNcrs,
  ] = await Promise.all([
    db.job.count({
      where: { status: { in: ['pending_artwork', 'artwork_approved', 'in_production', 'folding', 'final_qc', 'packing'] } },
    }),
    db.jobStage.count({ where: { completedAt: null } }),
    Promise.all([
      db.sheetIssue.count({ where: { isExcess: true, approvedAt: null, rejectedAt: null } }),
      db.artworkApproval.count({ where: { rejected: false } }),
      db.purchaseRequisition.count({ where: { status: 'pending' } }),
    ]),
    db.job.count({
      where: {
        status: { in: ['final_qc', 'packing'] },
      },
    }),
    db.machine.findMany({
      where: { machineCode: { in: ['CI-01', 'CI-02', 'CI-03'] } },
      orderBy: { machineCode: 'asc' },
    }),
    Promise.all([
      db.sheetIssue.findMany({
        where: { isExcess: true, approvedAt: null, rejectedAt: null },
        take: 5,
        include: { job: { select: { jobNumber: true } } },
      }),
      db.artwork.findMany({
        where: { status: { in: ['pending', 'partially_approved'] } },
        take: 5,
        include: { job: { select: { jobNumber: true, productName: true } } },
      }),
    ]),
    db.job.findMany({
      where: { status: { in: ['pending_artwork', 'artwork_approved', 'in_production', 'folding', 'final_qc', 'packing'] } },
      include: {
        customer: { select: { name: true } },
        workflowStages: true,
      },
      orderBy: { dueDate: 'asc' },
    }),
    db.rfq.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    }),
    db.inventory.findMany({
      where: { reorderPoint: { gt: 0 } },
      orderBy: { materialCode: 'asc' },
    }),
    db.job.findMany({
      include: {
        customer: { select: { name: true } },
        artwork: { select: { versionNumber: true, status: true, locksCompleted: true } },
      },
      orderBy: { dueDate: 'asc' },
    }),
    db.ncr.findMany({
      where: { status: 'open' },
      orderBy: { raisedAt: 'desc' },
      select: { id: true, severity: true },
    }),
  ])

  const pressStatuses = await Promise.all(
    presses.map(async (press) => {
      const [oee, activeStage] = await Promise.all([
        calculateOEE(press.id, today),
        db.jobStage.findFirst({
          where: { machineId: press.id, completedAt: null },
          include: { job: { select: { jobNumber: true, productName: true } } },
        }),
      ])

      return {
        machineCode: press.machineCode,
        machineName: press.name,
        status: press.status,
        job: activeStage?.job ?? null,
        oee: oee.oee,
        sheets: oee.totalSheets ?? 0,
        firstArticleStatus: null as string | null,
      }
    })
  )

  const avgOee = pressStatuses.length
    ? Math.round(
        (pressStatuses.reduce((sum, press) => sum + press.oee, 0) / pressStatuses.length) * 10
      ) / 10
    : 0

  const [excess, artworkPending] = alertsData
  const alerts: {
    type: string
    severity: 'critical' | 'warning' | 'info'
    title: string
    description: string
    link: string
    jobId?: string
  }[] = []

  for (const item of excess) {
    alerts.push({
      type: 'excess_sheet',
      severity: 'critical',
      title: 'Excess sheet request',
      description: `Job ${item.job.jobNumber} - approve excess sheets`,
      link: `/stores/approve-excess/${item.id}`,
      jobId: item.jobId,
    })
  }

  for (const item of artworkPending) {
    alerts.push({
      type: 'artwork',
      severity: 'warning',
      title: 'Artwork lock pending',
      description: `${item.job.jobNumber} - ${item.job.productName}`,
      link: `/artwork/${item.jobId}`,
      jobId: item.jobId,
    })
  }

  const pipeline = pipelineJobs.map((job) => {
    const stages = job.workflowStages
    const current =
      stages.find((stage) => stage.status === 'in_progress') ||
      stages.find((stage) => stage.status === 'pending') ||
      null
    const completedCount = stages.filter((stage) => stage.status === 'completed').length
    const percentComplete = stages.length ? Math.round((completedCount / stages.length) * 100) : 0

    return {
      id: job.id,
      jobNumber: job.jobNumber,
      productName: job.productName,
      customerName: job.customer.name,
      currentStageNumber: current?.stageNumber ?? null,
      currentStageName: current?.stageName ?? null,
      percentComplete,
      dueDate: job.dueDate,
    }
  })

  const stockAlerts = inventoryItems.filter(
    (item) =>
      Number(item.qtyAvailable) + Number(item.qtyQuarantine) <= Number(item.reorderPoint)
  )

  return NextResponse.json({
    stats: {
      activeJobs,
      runningPresses: runningStages,
      avgOee,
      pendingApprovals: pendingCounts[0] + pendingCounts[1] + pendingCounts[2],
      dispatchDue,
    },
    presses: pressStatuses,
    alerts,
    pipeline,
    rfqList,
    stockAlerts,
    jobsList,
    openNcrs,
  })
}
