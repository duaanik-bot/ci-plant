import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'

const stageLabelByKey: Record<string, string> = {
  cutting: 'Cutting',
  printing: 'Printing',
  chemical_coating: 'Chemical Coating',
  lamination: 'Lamination',
  spot_uv: 'Spot UV',
  leafing: 'Leafing',
  embossing: 'Embossing',
  dye_cutting: 'Dye Cutting',
  pasting: 'Pasting',
  sorting: 'Sorting',
}

const orderedStageKeys = [
  'cutting',
  'printing',
  'chemical_coating',
  'lamination',
  'spot_uv',
  'leafing',
  'embossing',
  'dye_cutting',
  'pasting',
] as const

function requiredStageKeysForRouting(postPressRouting: unknown): string[] {
  const pp = postPressRouting && typeof postPressRouting === 'object'
    ? (postPressRouting as Record<string, unknown>)
    : {}
  const out: string[] = ['cutting', 'printing']
  // Spot UV is treated as a coating subtype, not an independent execution station.
  if (pp.chemicalCoating === true || pp.spotUv === true) out.push('chemical_coating')
  if (pp.lamination === true) out.push('lamination')
  // Leafing/Embossing execute within Dye Cutting. Pasting is terminal → Dispatch → Billing.
  out.push('dye_cutting', 'pasting')
  return out
}

function keyToQueuedField(key: string): string {
  const token = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  return `${token}QueuedAt`
}

type ControlsPayload = {
  action?: 'bulk_reset_from_stage' | 'bulk_delete_from_stage' | 'reverse_row_stage'
  stageRecordIds?: string[]
  stageRecordId?: string
  confirm?: boolean
}

export async function POST(req: NextRequest, context: { params: Promise<{ stageKey: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { stageKey } = await context.params
  const stageLabel = stageLabelByKey[stageKey]
  if (!stageLabel) {
    return NextResponse.json({ error: 'Invalid stage key' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as ControlsPayload
  const action = body.action

  if (!action) return NextResponse.json({ error: 'Action is required' }, { status: 400 })
  if (!body.confirm) return NextResponse.json({ error: 'Confirmation required' }, { status: 400 })

  if (action === 'bulk_delete_from_stage') {
    const ids = Array.isArray(body.stageRecordIds) ? body.stageRecordIds.filter(Boolean) : []
    if (ids.length === 0) {
      return NextResponse.json({ error: 'Select at least one row' }, { status: 400 })
    }

    const rows = await db.productionStageRecord.findMany({
      where: { id: { in: ids }, stageName: stageLabel },
      select: { id: true, jobCardId: true, stageName: true },
    })

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No matching rows found' }, { status: 404 })
    }

    await db.productionStageRecord.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: {
        status: 'archived',
        counter: 0,
        operator: null,
        completedAt: null,
        lastProductionTickAt: null,
        inProgressSince: null,
      },
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'production_stage_records',
      recordId: 'bulk',
      newValue: {
        mode: 'trial_bulk_delete_from_stage',
        stageKey,
        stageName: stageLabel,
        stageRecordIds: rows.map((r) => r.id),
        jobCardIds: rows.map((r) => r.jobCardId),
      },
    })

    return NextResponse.json({ success: true, deleted: rows.length })
  }

  if (action === 'bulk_reset_from_stage') {
    const rows = await db.productionStageRecord.findMany({
      where: {
        stageName: stageLabel,
        ...(Array.isArray(body.stageRecordIds) && body.stageRecordIds.length > 0
          ? { id: { in: body.stageRecordIds } }
          : {}),
      },
      include: {
        jobCard: {
          include: {
            stages: {
              select: { id: true, stageName: true },
            },
          },
        },
      },
    })

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No rows found to reset' }, { status: 404 })
    }

    const updatedJobCardIds: string[] = []

    await db.$transaction(async (tx) => {
      for (const row of rows) {
        const jc = row.jobCard
        const seq = requiredStageKeysForRouting(jc.postPressRouting)
        const fromIdx = seq.indexOf(stageKey)
        if (fromIdx < 0) continue

        const resetKeys = seq.slice(fromIdx)
        const resetLabels = resetKeys.map((k) => stageLabelByKey[k]).filter(Boolean)

        await tx.productionStageRecord.updateMany({
          where: {
            jobCardId: jc.id,
            stageName: { in: resetLabels },
          },
          data: {
            status: 'pending',
            counter: 0,
            operator: null,
            completedAt: null,
            lastProductionTickAt: null,
            inProgressSince: null,
          },
        })

        const pp = jc.postPressRouting && typeof jc.postPressRouting === 'object'
          ? (jc.postPressRouting as Record<string, unknown>)
          : {}
        const exec = pp.executionOrchestration && typeof pp.executionOrchestration === 'object'
          ? ({ ...(pp.executionOrchestration as Record<string, unknown>) })
          : {}

        const stageProgressRaw = exec.stageProgress && typeof exec.stageProgress === 'object'
          ? ({ ...(exec.stageProgress as Record<string, unknown>) })
          : {}

        for (const k of resetKeys) {
          const existing = stageProgressRaw[k] && typeof stageProgressRaw[k] === 'object'
            ? (stageProgressRaw[k] as Record<string, unknown>)
            : {}
          stageProgressRaw[k] = {
            ...existing,
            plannedQty: Number(existing.plannedQty ?? 0),
            completedQty: 0,
            pushedQty: 0,
            wastageQty: 0,
            status: 'pending',
            approvalStatus: 'pending',
            completedAt: null,
            approvedAt: null,
          }
          const qField = keyToQueuedField(k)
          delete exec[qField]
        }

        exec.stageProgress = stageProgressRaw
        const nextPostPress = {
          ...pp,
          executionOrchestration: exec,
        }

        await tx.productionJobCard.update({
          where: { id: jc.id },
          data: { postPressRouting: nextPostPress as unknown as Prisma.InputJsonValue },
        })

        updatedJobCardIds.push(jc.id)
      }
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'production_stage_records',
      recordId: 'bulk',
      newValue: {
        mode: 'trial_reset_from_stage',
        stageKey,
        stageName: stageLabel,
        resetFrom: stageKey,
        jobCardIds: updatedJobCardIds,
      },
    })

    return NextResponse.json({ success: true, resetJobs: updatedJobCardIds.length })
  }

  if (action === 'reverse_row_stage') {
    const stageRecordId = String(body.stageRecordId || '').trim()
    if (!stageRecordId) return NextResponse.json({ error: 'stageRecordId is required' }, { status: 400 })

    const row = await db.productionStageRecord.findUnique({
      where: { id: stageRecordId },
      include: {
        jobCard: {
          include: {
            stages: {
              select: { id: true, stageName: true, status: true },
            },
          },
        },
      },
    })

    if (!row || row.stageName !== stageLabel) {
      return NextResponse.json({ error: 'Stage row not found' }, { status: 404 })
    }

    const seq = requiredStageKeysForRouting(row.jobCard.postPressRouting)
    const idx = seq.indexOf(stageKey)
    if (idx <= 0) {
      return NextResponse.json({ error: 'No previous stage available' }, { status: 400 })
    }

    const prevKey = seq[idx - 1]!
    const prevLabel = stageLabelByKey[prevKey]
    const prevStage = row.jobCard.stages.find((s) => s.stageName === prevLabel)
    if (!prevStage) {
      return NextResponse.json({ error: `Previous stage missing: ${prevLabel}` }, { status: 400 })
    }

    const pp = row.jobCard.postPressRouting && typeof row.jobCard.postPressRouting === 'object'
      ? (row.jobCard.postPressRouting as Record<string, unknown>)
      : {}
    const exec = pp.executionOrchestration && typeof pp.executionOrchestration === 'object'
      ? ({ ...(pp.executionOrchestration as Record<string, unknown>) })
      : {}
    const stageProgress = exec.stageProgress && typeof exec.stageProgress === 'object'
      ? ({ ...(exec.stageProgress as Record<string, unknown>) })
      : {}

    const currentProgress = stageProgress[stageKey] && typeof stageProgress[stageKey] === 'object'
      ? ({ ...(stageProgress[stageKey] as Record<string, unknown>) })
      : {}
    const prevProgress = stageProgress[prevKey] && typeof stageProgress[prevKey] === 'object'
      ? ({ ...(stageProgress[prevKey] as Record<string, unknown>) })
      : {}

    const movedBackQty = Number(currentProgress.completedQty ?? row.counter ?? 0)

    stageProgress[stageKey] = {
      ...currentProgress,
      completedQty: 0,
      pushedQty: 0,
      wastageQty: 0,
      status: 'pending',
      completedAt: null,
      approvedAt: null,
      approvalStatus: 'pending',
    }
    stageProgress[prevKey] = {
      ...prevProgress,
      status: 'in_progress',
      plannedQty: Number(prevProgress.plannedQty ?? 0) + Math.max(0, movedBackQty),
    }

    const qField = keyToQueuedField(stageKey)
    delete exec[qField]

    const trail = Array.isArray(exec.stagePushTrail) ? exec.stagePushTrail as Array<Record<string, unknown>> : []
    exec.stagePushTrail = [
      ...trail,
      {
        at: new Date().toISOString(),
        event: 'reverse_row_stage',
        fromStage: stageKey,
        toStage: prevKey,
        qtyTransferred: Math.max(0, movedBackQty),
        jobCardId: row.jobCard.id,
        actor: user?.name ?? user?.email ?? 'system',
      },
    ]
    exec.stageProgress = stageProgress

    await db.$transaction(async (tx) => {
      await tx.productionStageRecord.update({
        where: { id: row.id },
        data: {
          status: 'pending',
          counter: 0,
          operator: null,
          completedAt: null,
          lastProductionTickAt: null,
          inProgressSince: null,
        },
      })
      await tx.productionStageRecord.update({
        where: { id: prevStage.id },
        data: {
          status: 'in_progress',
          inProgressSince: new Date(),
        },
      })
      await tx.productionJobCard.update({
        where: { id: row.jobCard.id },
        data: {
          postPressRouting: ({
            ...pp,
            executionOrchestration: exec,
          }) as unknown as Prisma.InputJsonValue,
        },
      })
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'production_stage_records',
      recordId: row.id,
      newValue: {
        mode: 'reverse_row_stage',
        fromStage: stageKey,
        toStage: prevKey,
        jobCardId: row.jobCard.id,
        movedBackQty: Math.max(0, movedBackQty),
      },
    })

    return NextResponse.json({ success: true, movedTo: prevKey })
  }

  return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
}
