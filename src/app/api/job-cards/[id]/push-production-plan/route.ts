import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { db } from '@/lib/db'
import { PRODUCTION_STAGES_TAG } from '@/lib/constants'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { computeBoardMaterialForJobCard } from '@/lib/job-card-board-material'

export const dynamic = 'force-dynamic'

const JOB_CARDS_TAG = 'job-cards'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}
}

/** Explicit job-card handoff: information can flow even when board stock is still pending. */
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
    select: {
      id: true,
      specOverrides: true,
      materialProcurementStatus: true,
      materialQueue: {
        select: { totalSheets: true, boardType: true, gsm: true },
      },
    },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found for job card' }, { status: 404 })

  const board = await computeBoardMaterialForJobCard(
    db,
    { id: jc.id, totalSheets: jc.totalSheets, sheetsIssued: jc.sheetsIssued },
    {
      materialProcurementStatus: line.materialProcurementStatus,
      materialQueue: line.materialQueue,
    },
  )
  const boardReady = board.boardStatus === 'available' && !board.materialShortage
  const boardReadiness = boardReady ? 'ready' : board.incomingQty && board.incomingQty > 0 ? 'waiting' : 'not_ready'
  const now = new Date().toISOString()

  const prevRouting = asRecord(jc.postPressRouting)
  const prevSetup = asRecord(prevRouting.executionSetup)
  const prevPrintPlan = asRecord(prevRouting.printPlan)
  const prevRoutingOrchestration = asRecord(prevRouting.executionOrchestration)
  const prevSpec = asRecord(line.specOverrides)
  const prevSpecOrchestration = asRecord(prevSpec.executionOrchestration)
  const cuttingStage = jc.stages.find((s) => s.stageName === 'Cutting')
  const printingStage = jc.stages.find((s) => s.stageName === 'Printing')

  const nextRouting = {
    ...prevRouting,
    printPlan: {
      lane: 'triage',
      machineId: null,
      order: typeof prevPrintPlan.order === 'number' ? prevPrintPlan.order : 0,
      updatedAt: now,
      pushedFromJobCardAt: now,
    },
    executionSetup: {
      ...prevSetup,
      boardReadiness,
      materialSignal: boardReady ? 'Board available' : 'Board not available',
      materialSignalAt: now,
      materialShortageSheets: board.shortageSheets ?? 0,
      availableStockSheets: board.availableStock ?? board.paperWarehouseSheetsForSpec,
      incomingSheets: board.incomingQty ?? 0,
    },
    executionOrchestration: {
      ...prevRoutingOrchestration,
      cuttingQueuedAt: prevRoutingOrchestration.cuttingQueuedAt ?? now,
      printingQueuedAt: prevRoutingOrchestration.printingQueuedAt ?? now,
      productionPlanPushedAt: now,
      productionPlanPushedByUserId: user!.id,
      materialOverrideNotice: boardReady
        ? null
        : 'Pushed without material hard block. Board not available; proceed with planning visibility only.',
    },
  }

  const nextSpec = {
    ...prevSpec,
    executionOrchestration: {
      ...prevSpecOrchestration,
      cuttingQueueEnqueuedAt: prevSpecOrchestration.cuttingQueueEnqueuedAt ?? now,
      cuttingQueueEnqueuedByUserId: prevSpecOrchestration.cuttingQueueEnqueuedByUserId ?? user!.id,
      printPlanningQueuedAt: prevSpecOrchestration.printPlanningQueuedAt ?? now,
      printPlanningQueuedByUserId: prevSpecOrchestration.printPlanningQueuedByUserId ?? user!.id,
      productionPlanPushedAt: now,
    },
  }

  await db.$transaction(async (tx) => {
    await tx.productionJobCard.update({
      where: { id: jc.id },
      data: {
        qaReleased: true,
        status: jc.status === 'closed' ? jc.status : 'qa_released',
        postPressRouting: nextRouting as object,
      },
    })

    await tx.poLineItem.update({
      where: { id: line.id },
      data: { specOverrides: nextSpec as object },
    })

    const readyIfPending = async (stageName: 'Cutting' | 'Printing', stageId: string | null) => {
      if (stageId) {
        await tx.productionStageRecord.update({
          where: { id: stageId },
          data: { status: { set: 'ready' } },
        })
        return
      }
      await tx.productionStageRecord.create({
        data: {
          jobCardId: jc.id,
          stageName,
          status: 'ready',
          operator: jc.assignedOperator ?? null,
          counter: 0,
          sheetSize: null,
        },
      })
    }

    if (!cuttingStage || cuttingStage.status === 'pending') {
      await readyIfPending('Cutting', cuttingStage?.id ?? null)
    }
    if (!printingStage || printingStage.status === 'pending') {
      await readyIfPending('Printing', printingStage?.id ?? null)
    }
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'production_job_cards',
    recordId: jc.id,
    newValue: {
      productionPlanPushedAt: now,
      pushedTo: ['cutting', 'print_planning'],
      boardReadiness,
      materialSignal: boardReady ? 'Board available' : 'Board not available',
      jobCardNumber: jc.jobCardNumber,
    },
  })

  revalidateTag(JOB_CARDS_TAG)
  revalidateTag(PRODUCTION_STAGES_TAG)

  return NextResponse.json({
    ok: true as const,
    boardReadiness,
    materialSignal: boardReady ? 'Board available' : 'Board not available',
    shortageSheets: board.shortageSheets ?? 0,
  })
}
