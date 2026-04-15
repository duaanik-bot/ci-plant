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
          select: { jobCardNumber: true, cartonName: true },
        })
      : []
  const productNameByJc = new Map<number, string>()
  poLines.forEach((l) => {
    if (l.jobCardNumber != null) productNameByJc.set(l.jobCardNumber, l.cartonName)
  })

  const jobCards = records.map((r) => ({
    stageRecord: {
      id: r.id,
      stageName: r.stageName,
      status: r.status,
      operator: r.operator,
      counter: r.counter,
      sheetSize: r.sheetSize,
      completedAt: r.completedAt?.toISOString() ?? null,
    },
    jobCard: r.jobCard
      ? {
          id: r.jobCard.id,
          jobCardNumber: r.jobCard.jobCardNumber,
          setNumber: r.jobCard.setNumber,
          batchNumber: r.jobCard.batchNumber,
          requiredSheets: r.jobCard.requiredSheets,
          totalSheets: r.jobCard.totalSheets,
          status: r.jobCard.status,
          customer: r.jobCard.customer,
          productName:
            r.jobCard.jobCardNumber != null
              ? productNameByJc.get(r.jobCard.jobCardNumber) ?? null
              : null,
        }
      : null,
  }))

  return NextResponse.json({
    stageKey,
    stageLabel,
    jobCards: jobCards.filter((x) => x.jobCard != null),
  })
}
