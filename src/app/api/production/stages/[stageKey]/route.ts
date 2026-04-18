import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { PRODUCTION_STAGES } from '@/lib/constants'

export const dynamic = 'force-dynamic'

const stageLabelByKey: Record<string, string> = {}
PRODUCTION_STAGES.forEach((s) => {
  stageLabelByKey[s.key] = s.label
})

// Stages 3–7 are conditional: only show job cards with matching postPressRouting flag
const postPressRoutingKeyByStageKey: Record<string, string> = {
  chemical_coating: 'chemicalCoating',
  lamination: 'lamination',
  spot_uv: 'spotUv',
  leafing: 'leafing',
  embossing: 'embossing',
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ stageKey: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { stageKey } = await context.params
  const stageLabel = stageLabelByKey[stageKey]
  if (!stageLabel) {
    return NextResponse.json({ error: 'Invalid stage key' }, { status: 400 })
  }

  const routingKey = postPressRoutingKeyByStageKey[stageKey]
  const where: {
    stageName: string
    jobCard?: { postPressRouting: { path: string[]; equals: boolean } }
  } = { stageName: stageLabel }
  if (routingKey) {
    where.jobCard = {
      postPressRouting: { path: [routingKey], equals: true },
    }
  }

  const records = await db.productionStageRecord.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      jobCard: {
        include: {
          customer: { select: { id: true, name: true } },
        },
      },
    },
  })

  const jcNumbers = records
    .map((r) => r.jobCard?.jobCardNumber)
    .filter((n): n is number => n != null)
  const uniqJcNumbers = Array.from(new Set(jcNumbers))
  const poLines =
    uniqJcNumbers.length > 0
      ? await db.poLineItem.findMany({
          where: { jobCardNumber: { in: uniqJcNumbers } },
          select: {
            jobCardNumber: true,
            cartonName: true,
            directorPriority: true,
            po: { select: { isPriority: true } },
          },
        })
      : []
  const productNameByJc = new Map<number, string>()
  const priorityByJc = new Map<number, boolean>()
  poLines.forEach((l) => {
    if (l.jobCardNumber != null) {
      productNameByJc.set(l.jobCardNumber, l.cartonName)
      if (l.directorPriority || l.po.isPriority) {
        priorityByJc.set(l.jobCardNumber, true)
      }
    }
  })

  function idleHoursForStage(
    status: string,
    stageCreatedAt: Date,
    jobUpdatedAt: Date,
  ): number | null {
    if (status === 'completed') return null
    if (status === 'pending') {
      return (Date.now() - stageCreatedAt.getTime()) / 3_600_000
    }
    if (status === 'in_progress') {
      return (Date.now() - jobUpdatedAt.getTime()) / 3_600_000
    }
    return (Date.now() - stageCreatedAt.getTime()) / 3_600_000
  }

  const jobCards = records.map((r) => {
    const jc = r.jobCard
    const idleHours =
      jc != null ? idleHoursForStage(r.status, r.createdAt, jc.updatedAt) : null
    return {
      stageRecord: {
        id: r.id,
        stageName: r.stageName,
        status: r.status,
        operator: r.operator,
        counter: r.counter,
        sheetSize: r.sheetSize,
        completedAt: r.completedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      },
      idleHours,
      jobCard: jc
        ? {
            id: jc.id,
            jobCardNumber: jc.jobCardNumber,
            setNumber: jc.setNumber,
            batchNumber: jc.batchNumber,
            requiredSheets: jc.requiredSheets,
            totalSheets: jc.totalSheets,
            status: jc.status,
            customer: jc.customer,
            updatedAt: jc.updatedAt.toISOString(),
            industrialPriority:
              jc.jobCardNumber != null && priorityByJc.get(jc.jobCardNumber) === true,
            productName:
              jc.jobCardNumber != null ? productNameByJc.get(jc.jobCardNumber) ?? null : null,
          }
        : null,
    }
  })

  return NextResponse.json({
    stageKey,
    stageLabel,
    jobCards: jobCards.filter((x) => x.jobCard != null),
  })
}
