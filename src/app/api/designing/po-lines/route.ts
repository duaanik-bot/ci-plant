import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { readOrchestration } from '@/lib/orchestration-spec'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const customerId = searchParams.get('customerId')

  const list = await db.poLineItem.findMany({
    where: {
      ...(customerId ? { po: { customerId } } : {}),
      planningStatus: { in: ['planned', 'design_ready', 'job_card_created'] },
    },
    orderBy: { createdAt: 'desc' },
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

  // Attach minimal readiness flags on the server for stable UI
  const mapped = await Promise.all(
    list.map(async (li) => {
      const hasSet = !!li.setNumber?.trim()
      const hasJobCard = !!li.jobCardNumber
      const jc = hasJobCard
        ? await db.productionJobCard.findFirst({
            where: { jobCardNumber: li.jobCardNumber! },
            select: {
              id: true,
              jobCardNumber: true,
              artworkApproved: true,
              firstArticlePass: true,
              finalQcPass: true,
              qaReleased: true,
              status: true,
            },
          })
        : null

      const readyForProduction = hasSet && !!jc?.artworkApproved && !!jc?.firstArticlePass
      const spec = (li.specOverrides as Record<string, unknown> | null) || {}
      const approvalsComplete = !!(
        spec.customerApprovalPharma &&
        spec.shadeCardQaTextApproval
      )
      const prePressFinalized = !!spec.prePressSentToPlateHubAt
      let artworkStatusLabel = 'Awaiting approval'
      if (prePressFinalized) artworkStatusLabel = 'Finalized'
      else if (approvalsComplete) artworkStatusLabel = 'Approved'

      const orch = readOrchestration(spec)
      const planningForwarded =
        !!orch.planningForwardedAt ||
        orch.planningFlowStatus === 'forwarded' ||
        orch.planningFlowStatus === 'in_progress'

      return {
        ...li,
        jobCard: jc,
        readiness: {
          hasSet,
          hasJobCard,
          artworkApproved: !!jc?.artworkApproved,
          /** @deprecated use approvalsComplete / artworkStatusLabel */
          artworkLocksCompleted: approvalsComplete ? 2 : 0,
          approvalsComplete,
          prePressFinalized,
          artworkStatusLabel,
          firstArticlePass: !!jc?.firstArticlePass,
          readyForProduction,
          planningForwarded,
          plateFlowStatus: orch.plateFlowStatus ?? null,
        },
      }
    })
  )

  return NextResponse.json(mapped)
}

