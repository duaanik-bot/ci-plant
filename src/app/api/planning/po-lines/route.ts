import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('planningStatus')
  const customerId = searchParams.get('customerId')

  const where: any = {}
  if (status) where.planningStatus = status
  if (customerId) where.po = { customerId }

  const list = await db.poLineItem.findMany({
    where,
    orderBy: [{ directorPriority: 'desc' }, { directorHold: 'asc' }, { createdAt: 'desc' }],
    include: {
      po: {
        select: {
          id: true,
          poNumber: true,
          status: true,
          poDate: true,
          customer: { select: { id: true, name: true } },
        },
      },
    },
  })

  const enriched = await Promise.all(
    list.map(async (li) => {
      const jc = li.jobCardNumber
        ? await db.productionJobCard.findFirst({
            where: { jobCardNumber: li.jobCardNumber },
            select: {
              id: true,
              jobCardNumber: true,
              artworkApproved: true,
              firstArticlePass: true,
              finalQcPass: true,
              qaReleased: true,
              plateSetId: true,
              status: true,
            },
          })
        : null

      const spec = li.specOverrides && typeof li.specOverrides === 'object'
        ? (li.specOverrides as Record<string, unknown>)
        : {}

      const specTwoApprovals = !!(spec.customerApprovalPharma && spec.shadeCardQaTextApproval)
      const artworkLocksCompleted = specTwoApprovals
        ? 2
        : Number(
            spec.artworkLocksCompleted ??
              (jc
                ? (jc.artworkApproved ? 1 : 0) +
                  (jc.finalQcPass ? 1 : 0) +
                  (jc.qaReleased ? 1 : 0) +
                  (jc.qaReleased ? 1 : 0)
                : 0),
          )
      const platesStatus = String(spec.platesStatus ?? (jc?.plateSetId ? 'available' : 'new_required'))
      const dieStatus = String(spec.dieStatus ?? (li.dyeId ? 'good' : 'not_available'))
      const machineAllocated = !!(spec.machineId && String(spec.machineId).trim())

      return {
        ...li,
        jobCard: jc,
        readiness: {
          artworkLocksCompleted,
          platesStatus,
          dieStatus,
          machineAllocated,
        },
      }
    })
  )

  return NextResponse.json(enriched)
}

