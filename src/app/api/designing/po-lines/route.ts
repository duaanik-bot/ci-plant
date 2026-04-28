import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { readOrchestration } from '@/lib/orchestration-spec'
import { PLANNING_DESIGNERS, readPlanningCore } from '@/lib/planning-decision-spec'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const customerId = searchParams.get('customerId')
  const myJobs = searchParams.get('myJobs') === '1'

  const list = await db.poLineItem.findMany({
    where: {
      ...(customerId ? { po: { customerId } } : {}),
      planningStatus: { in: ['planned', 'design_ready', 'job_card_created'] },
    },
    orderBy: [
      { directorPriority: 'desc' },
      { po: { isPriority: 'desc' } },
      { directorHold: 'asc' },
      { createdAt: 'desc' },
    ],
    include: {
      po: {
        select: {
          id: true,
          poNumber: true,
          status: true,
          poDate: true,
          isPriority: true,
          customer: { select: { id: true, name: true, logoUrl: true } },
        },
      },
      materialQueue: { select: { totalSheets: true } },
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
              fileUrl: true,
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

      const awCode = li.artworkCode?.trim()
      let artworkPreviewUrl: string | null = null
      let artworkStatus: string | null = null
      if (awCode) {
        const art = await db.artwork.findFirst({
          where: {
            filename: { equals: awCode, mode: 'insensitive' },
            job: { customerId: li.po.customer.id },
          },
          orderBy: [{ versionNumber: 'desc' }, { createdAt: 'desc' }],
          select: { fileUrl: true, status: true },
        })
        if (art?.fileUrl) {
          artworkPreviewUrl = art.fileUrl
          artworkStatus = art.status
        }
      }
      if (!artworkPreviewUrl && jc?.fileUrl) {
        artworkPreviewUrl = jc.fileUrl
      }

      const jcStatus = (jc?.status ?? '').toLowerCase()
      const revisionRequired =
        !!spec.revisionRequired ||
        artworkStatus === 'partially_approved' ||
        jcStatus === 'revision' ||
        jcStatus === 'rework'

      let pipelinePhase: 'finalized' | 'revision' | 'awaiting_client' | 'drafting' = 'drafting'
      if (prePressFinalized) pipelinePhase = 'finalized'
      else if (revisionRequired) pipelinePhase = 'revision'
      else if (!approvalsComplete) pipelinePhase = 'awaiting_client'

      return {
        ...li,
        jobCard: jc,
        artworkPreviewUrl,
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
          pipelinePhase,
          revisionRequired,
        },
      }
    })
  )

  if (myJobs && user?.name?.trim()) {
    const uname = user.name.trim().toLowerCase()
    const filtered = mapped.filter((li) => {
      const spec = (li.specOverrides as Record<string, unknown> | null) ?? {}
      const disp =
        typeof spec.planningDesignerDisplayName === 'string'
          ? spec.planningDesignerDisplayName.trim().toLowerCase()
          : ''
      const key = readPlanningCore(spec).designerKey
      const fromKey = key ? PLANNING_DESIGNERS[key].toLowerCase() : ''
      if (disp && uname === disp) return true
      if (fromKey && uname === fromKey) return true
      return false
    })
    return NextResponse.json(filtered)
  }

  return NextResponse.json(mapped)
}

