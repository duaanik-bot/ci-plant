import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { calculateRequirement, reserveMaterial, ShortagePrRecoveryError } from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const line = await db.poLineItem.findUnique({ where: { id } })
  if (!line) return NextResponse.json({ error: 'Planning line not found' }, { status: 404 })

  const jobCard = line.jobCardNumber
    ? await db.productionJobCard.findFirst({ where: { jobCardNumber: line.jobCardNumber } })
    : null
  if (!jobCard) {
    return NextResponse.json({ error: 'Job card missing for planning line' }, { status: 400 })
  }

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const core = (spec.planningCore as Record<string, unknown> | undefined) || {}
  const ups = Math.max(1, Math.floor(n((spec.meta as Record<string, unknown> | undefined)?.ups ?? core.ups ?? 1)))
  const wastagePct = Math.max(0, n(spec.wastagePct ?? core.wastagePct ?? 0))

  const baseRequired = Math.ceil(n(line.quantity) / ups)
  const requiredSheets = Math.max(1, Math.ceil(baseRequired + baseRequired * (wastagePct / 100)))

  const req = await calculateRequirement({ jobCardId: jobCard.id, planningId: id })
  const materialId = req.materialId
  if (!materialId) {
    return NextResponse.json({ error: 'No material mapped for this planning line' }, { status: 400 })
  }

  let result: Awaited<ReturnType<typeof reserveMaterial>>
  try {
    result = await reserveMaterial(materialId, jobCard.id, requiredSheets, id)
  } catch (error) {
    if (error instanceof ShortagePrRecoveryError) {
      return NextResponse.json(
        {
          error: error.message,
          retryable: true,
          shortageId: error.shortageId,
          action: 'create_pr_for_shortage',
        },
        { status: 409 },
      )
    }
    throw error
  }

  return NextResponse.json({
    success: true,
    planningId: id,
    jobCardId: jobCard.id,
    materialId,
    requiredSheets,
    reservedSheets: result.reservedSheets,
    shortageSheets: result.shortageSheets,
    status: result.status,
    purchaseRequestId: result.purchaseRequest?.id ?? null,
    shortageId: result.shortage?.id ?? null,
  })
}
