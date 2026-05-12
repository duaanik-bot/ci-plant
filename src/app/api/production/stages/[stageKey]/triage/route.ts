import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { PRODUCTION_STAGES } from '@/lib/constants'
import { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

const STAGE_LABEL_BY_KEY = new Map(PRODUCTION_STAGES.map((s) => [s.key, s.label]))

type TriagePatch = {
  stageRecordId: string
  jobCardId: string
  status?: string
  sequenceNo?: number
  priorityRank?: number
  plannedStartTime?: string | null
  machineId?: string | null
  operator?: string | null
  holdReason?: string | null
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ stageKey: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { stageKey } = await context.params
  const stageLabel = STAGE_LABEL_BY_KEY.get(stageKey)
  if (!stageLabel) return NextResponse.json({ error: 'Invalid stage key' }, { status: 400 })

  const body = (await req.json().catch(() => null)) as TriagePatch | null
  if (!body?.jobCardId || !body?.stageRecordId) {
    return NextResponse.json({ error: 'jobCardId and stageRecordId are required' }, { status: 400 })
  }

  const stageRecord = await db.productionStageRecord.findUnique({
    where: { id: body.stageRecordId },
    select: { id: true, stageName: true, jobCardId: true, status: true, operator: true },
  })
  if (!stageRecord || stageRecord.jobCardId !== body.jobCardId || stageRecord.stageName !== stageLabel) {
    return NextResponse.json({ error: 'Stage record mismatch' }, { status: 404 })
  }

  const jc = await db.productionJobCard.findUnique({
    where: { id: body.jobCardId },
    select: { id: true, postPressRouting: true },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const ppr = asObject(jc.postPressRouting)
  const exec = asObject(ppr.executionOrchestration)
  const triageByStage = asObject(exec.triageByStage)
  const stageTriage = asObject(triageByStage[stageKey])
  const prev = asObject(stageTriage[body.stageRecordId])

  const next = {
    ...prev,
    sequenceNo: Number.isFinite(body.sequenceNo) ? Math.max(1, Math.floor(Number(body.sequenceNo))) : Number(prev.sequenceNo ?? 9999),
    priorityRank: Number.isFinite(body.priorityRank) ? Math.max(1, Math.floor(Number(body.priorityRank))) : Number(prev.priorityRank ?? 100),
    plannedStartTime: body.plannedStartTime === undefined ? (prev.plannedStartTime ?? null) : body.plannedStartTime,
    machineId: body.machineId === undefined ? (prev.machineId ?? null) : body.machineId,
    operator: body.operator === undefined ? (prev.operator ?? null) : body.operator,
    holdReason: body.holdReason === undefined ? (prev.holdReason ?? null) : body.holdReason,
    status: body.status ?? String(prev.status ?? stageRecord.status ?? 'pending').toLowerCase(),
    updatedAt: new Date().toISOString(),
  }

  const nextStageTriage = { ...stageTriage, [body.stageRecordId]: next }
  const nextTriageByStage = { ...triageByStage, [stageKey]: nextStageTriage }

  const nextTrail = [
    ...(Array.isArray(exec.stagePushTrail) ? exec.stagePushTrail : []),
    {
      at: new Date().toISOString(),
      event: 'triage_update',
      stage: stageKey,
      jobCardId: body.jobCardId,
      stageRecordId: body.stageRecordId,
      status: next.status,
      sequenceNo: next.sequenceNo,
      priorityRank: next.priorityRank,
      machineId: next.machineId,
      operator: next.operator,
    },
  ]

  await db.productionJobCard.update({
    where: { id: body.jobCardId },
    data: {
      postPressRouting: ({
        ...ppr,
        executionOrchestration: {
          ...exec,
          triageByStage: nextTriageByStage,
          stagePushTrail: nextTrail,
        },
      } as Prisma.InputJsonValue),
    },
  })

  if (body.status) {
    await db.productionStageRecord.update({
      where: { id: body.stageRecordId },
      data: { status: body.status, operator: body.operator === undefined ? stageRecord.operator : body.operator },
    })
  } else if (body.operator !== undefined) {
    await db.productionStageRecord.update({
      where: { id: body.stageRecordId },
      data: { operator: body.operator },
    })
  }

  return NextResponse.json({ ok: true, triage: next })
}
