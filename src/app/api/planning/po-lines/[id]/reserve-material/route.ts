import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { calculateRequirement, reserveMaterial, ShortagePrRecoveryError } from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

async function resolvePlanningContext(id: string) {
  const line = await db.poLineItem.findUnique({ where: { id } })
  if (!line) return { error: NextResponse.json({ error: 'Planning line not found' }, { status: 404 }) as NextResponse }

  const jobCard = line.jobCardNumber
    ? await db.productionJobCard.findFirst({ where: { jobCardNumber: line.jobCardNumber } })
    : null
  if (!jobCard) {
    return { error: NextResponse.json({ error: 'Job card missing for planning line' }, { status: 400 }) as NextResponse }
  }

  return { line, jobCard }
}

function readinessStatus(
  requiredSheets: number,
  availableSheets: number,
  reservedSheets: number,
  shortageSheets: number,
  hasMaterial: boolean,
): 'green' | 'yellow' | 'red' | 'grey' {
  if (!hasMaterial) return 'grey'
  if (shortageSheets > 0 || availableSheets <= 0) return 'red'
  if (availableSheets < requiredSheets || reservedSheets < requiredSheets) return 'yellow'
  return 'green'
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const ctx = await resolvePlanningContext(id)
  if ('error' in ctx) return ctx.error

  const req = await calculateRequirement({ jobCardId: ctx.jobCard.id, planningId: id })
  const materialId = req.materialId
  const material = materialId ? await db.inventory.findUnique({ where: { id: materialId } }) : null

  const requiredSheets = Math.max(1, Number(req.requiredSheets) || 0)
  const availableSheets = Math.max(0, Number(material?.qtyAvailable) || 0)
  const reservedSheets = Math.max(0, Number(material?.qtyReserved) || 0)
  const incomingSheets = Math.max(0, Number(material?.qtyQuarantine) || 0)
  const shortageSheets = materialId ? Math.max(0, requiredSheets - availableSheets) : requiredSheets

  const pr = materialId
    ? await db.purchaseRequisition.findFirst({
        where: { materialId, sourceJobCardId: ctx.jobCard.id },
        orderBy: { raisedAt: 'desc' },
        select: { status: true, expectedDelivery: true },
      })
    : null

  return NextResponse.json({
    planningId: id,
    jobCardId: ctx.jobCard.id,
    materialId,
    materialCode: material?.materialCode ?? null,
    boardType: material?.boardType ?? null,
    boardClassification: material?.boardClassification ?? null,
    size: material?.sheetLength && material?.sheetWidth ? `${Number(material.sheetLength)} x ${Number(material.sheetWidth)}` : null,
    gsm: material?.gsm ?? null,
    requiredSheets,
    availableSheets,
    reservedSheets,
    incomingSheets,
    shortageSheets,
    prStatus: pr?.status ?? 'not_created',
    grnEta: pr?.expectedDelivery ? pr.expectedDelivery.toISOString() : null,
    status: readinessStatus(requiredSheets, availableSheets, reservedSheets, shortageSheets, Boolean(materialId)),
  })
}

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const ctx = await resolvePlanningContext(id)
  if ('error' in ctx) return ctx.error
  const { line, jobCard } = ctx

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
