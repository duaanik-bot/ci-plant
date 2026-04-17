import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const li = await db.poLineItem.findUnique({
    where: { id },
    include: {
      po: { include: { customer: true } },
      dieMaster: {
        select: {
          id: true,
          dyeNumber: true,
          dyeType: true,
          condition: true,
          location: true,
          cartonSize: true,
          dimLengthMm: true,
          dimWidthMm: true,
          dimHeightMm: true,
        },
      },
    },
  })
  if (!li) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const carton = li.cartonId
    ? await db.carton.findUnique({
        where: { id: li.cartonId },
        select: {
          id: true,
          dieMasterId: true,
          dyeId: true,
          finishedLength: true,
          finishedWidth: true,
          finishedHeight: true,
          batchSpaceL: true,
          batchSpaceW: true,
          dieMaster: {
            select: {
              id: true,
              dyeNumber: true,
              dyeType: true,
              pastingStyle: true,
              dimLengthMm: true,
              dimWidthMm: true,
              dimHeightMm: true,
            },
          },
        },
      })
    : null

  const jc = li.jobCardNumber
    ? await db.productionJobCard.findFirst({
        where: { jobCardNumber: li.jobCardNumber },
        include: { customer: { select: { id: true, name: true } }, stages: true },
      })
    : null

  const checks = {
    hasSetNumber: !!li.setNumber?.trim(),
    hasJobCard: !!jc,
    artworkApproved: !!jc?.artworkApproved,
    firstArticlePass: !!jc?.firstArticlePass,
    finalQcPass: !!jc?.finalQcPass,
    qaReleased: !!jc?.qaReleased,
    poConfirmed: li.po.status === 'confirmed',
  }

  return NextResponse.json({
    line: { ...li, carton },
    jobCard: jc,
    checks,
    links: {
      po: `/orders/purchase-orders/${li.poId}`,
      planning: '/orders/planning',
      jobCard: jc ? `/production/job-cards/${jc.id}` : null,
      createJobCard: `/production/job-cards/new?poId=${li.poId}&lineId=${li.id}`,
    },
  })
}

