import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { readOrchestration } from '@/lib/orchestration-spec'
import { PLANNING_DESIGNERS, readPlanningCore, readPlanningMeta } from '@/lib/planning-decision-spec'

export const dynamic = 'force-dynamic'

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asPositiveNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function formatSheetPair(length: unknown, width: unknown): string {
  const l = asPositiveNumber(length)
  const w = asPositiveNumber(width)
  return l != null && w != null ? `${l}x${w}` : ''
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = asText(value)
    if (text) return text
  }
  return ''
}

function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = asPositiveNumber(value)
    if (n != null) return Math.floor(n)
  }
  return null
}

function compactAwSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...spec }
  delete copy.orchestration
  delete copy.designerCommand
  delete copy.plateHubPayload
  delete copy.smartMatchCandidates
  delete copy.smartMatchOverrideLog
  return copy
}

export async function GET(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const customerId = searchParams.get('customerId')
  const myJobs = searchParams.get('myJobs') === '1'
  const compact = searchParams.get('mode') === 'compact' || searchParams.get('compact') === '1'

  const list = await db.poLineItem.findMany({
    where: {
      ...(customerId ? { po: { customerId } } : {}),
      planningStatus: { in: ['design_ready', 'job_card_created'] },
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
      materialQueue: {
        select: {
          totalSheets: true,
          boardType: true,
          gsm: true,
          ups: true,
          sheetLengthMm: true,
          sheetWidthMm: true,
        },
      },
      dieMaster: {
        select: {
          id: true,
          dyeNumber: true,
          dyeType: true,
          sheetSize: true,
          ups: true,
        },
      },
      carton: {
        select: {
          blankLength: true,
          blankWidth: true,
          paperType: true,
          gsm: true,
          artworkCode: true,
          sheetSizeL: true,
          sheetSizeW: true,
          ups: true,
          dieMasterId: true,
          dyeId: true,
          dieMaster: {
            select: {
              id: true,
              dyeNumber: true,
              dyeType: true,
              sheetSize: true,
              ups: true,
            },
          },
          dye: {
            select: {
              id: true,
              dyeNumber: true,
              dyeType: true,
              sheetSize: true,
              ups: true,
            },
          },
        },
      },
    },
  })

  // AW queue must only show lines explicitly in AW statuses.

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
      const planningCore = readPlanningCore(spec)
      const planningMeta = readPlanningMeta(spec)
      const carton = li.carton
      const cartonDie = carton?.dieMaster ?? carton?.dye
      const enrichedSheetSize = firstText(
        spec.actualSheetSize,
        spec.sheetSize,
        planningCore.actualSheetSizeLabel,
        planningMeta.parentSize,
        formatSheetPair(planningMeta.sheetLengthMm, planningMeta.sheetWidthMm),
        formatSheetPair(li.materialQueue?.sheetLengthMm, li.materialQueue?.sheetWidthMm),
        li.dieMaster?.sheetSize,
        cartonDie?.sheetSize,
        formatSheetPair(carton?.sheetSizeL, carton?.sheetSizeW),
        formatSheetPair(carton?.blankLength, carton?.blankWidth),
      )
      const enrichedArtworkCode = firstText(li.artworkCode, spec.artworkCode, carton?.artworkCode)
      const enrichedDieNumber = firstText(
        spec.dieNumber,
        li.dieMaster?.dyeNumber != null ? String(li.dieMaster.dyeNumber) : '',
        cartonDie?.dyeNumber != null ? String(cartonDie.dyeNumber) : '',
      )
      const enrichedUps = firstPositiveNumber(
        spec.ups,
        planningCore.ups,
        planningMeta.ups,
        li.materialQueue?.ups,
        li.dieMaster?.ups,
        cartonDie?.ups,
        carton?.ups,
      )
      const enrichedSpecRaw = {
        ...spec,
        ...(enrichedSheetSize && !asText(spec.actualSheetSize) ? { actualSheetSize: enrichedSheetSize } : {}),
        ...(enrichedSheetSize && !asText(spec.sheetSize) ? { sheetSize: enrichedSheetSize } : {}),
        ...(enrichedArtworkCode && !asText(spec.artworkCode) ? { artworkCode: enrichedArtworkCode } : {}),
        ...(enrichedDieNumber && !asText(spec.dieNumber) ? { dieNumber: enrichedDieNumber } : {}),
        ...(enrichedUps != null && asPositiveNumber(spec.ups) == null ? { ups: enrichedUps } : {}),
      }
      const enrichedSpec = compact ? compactAwSpec(enrichedSpecRaw) : enrichedSpecRaw
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

      // Artwork preview path retired with the standalone Artwork table —
      // fall back to the job card's stored file URL if available.
      let artworkPreviewUrl: string | null = jc?.fileUrl ?? null
      const artworkStatus: string | null = null

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
        artworkCode: enrichedArtworkCode || li.artworkCode,
        specOverrides: enrichedSpec,
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
