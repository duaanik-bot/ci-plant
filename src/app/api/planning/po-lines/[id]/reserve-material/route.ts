import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { calculateRequirement, reserveMaterial, ShortagePrRecoveryError } from '@/lib/material-readiness-service'
import { parseSheetSizeToPair, resolveSheetSize } from '@/lib/planning-sheet-size'
import { buildMaterialCutFitOptions } from '@/lib/material-cut-fit'

export const dynamic = 'force-dynamic'

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

function formatSheetDim(value: unknown): string | null {
  const x = Number(value)
  if (!Number.isFinite(x) || x <= 0) return null
  return x.toString()
}

function parsePosInt(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const i = Math.floor(n)
  return i > 0 ? i : null
}

async function resolvePlanningContext(id: string) {
  const line = await db.poLineItem.findUnique({
    where: { id },
    include: {
      carton: {
        select: {
          id: true,
          paperType: true,
          gsm: true,
          blankLength: true,
          blankWidth: true,
        },
      },
      materialQueue: {
        select: {
          boardType: true,
          gsm: true,
          sheetLengthMm: true,
          sheetWidthMm: true,
        },
      },
    },
  })
  if (!line) return { error: NextResponse.json({ error: 'Planning line not found' }, { status: 404 }) as NextResponse }

  const jobCard = line.jobCardNumber
    ? await db.productionJobCard.findFirst({ where: { jobCardNumber: line.jobCardNumber } })
    : null
  if (!jobCard) {
    return { error: NextResponse.json({ error: 'Job card missing for planning line' }, { status: 400 }) as NextResponse }
  }

  return { line, jobCard }
}

async function resolveMaterialFromSpec(line: Record<string, unknown> & {
  specOverrides?: unknown
  paperType?: string | null
  gsm?: number | null
  carton?: Record<string, unknown> | null
  materialQueue?: Record<string, unknown> | null
}) {
  const spec = (line?.specOverrides as Record<string, unknown> | null) || {}
  const boardTypeRaw =
    (typeof line?.paperType === 'string' && line.paperType.trim()) ||
    (typeof line?.materialQueue?.boardType === 'string' && line.materialQueue.boardType.trim()) ||
    (typeof line?.carton?.paperType === 'string' && line.carton.paperType.trim()) ||
    null
  const boardClassificationRaw =
    (typeof spec.boardGrade === 'string' && spec.boardGrade.trim()) ||
    null
  const gsmRaw =
    (typeof line?.gsm === 'number' && Number.isFinite(line.gsm) && line.gsm > 0 ? line.gsm : null) ??
    (typeof line?.materialQueue?.gsm === 'number' && Number.isFinite(line.materialQueue.gsm) && line.materialQueue.gsm > 0
      ? line.materialQueue.gsm
      : null) ??
    (typeof line?.carton?.gsm === 'number' && Number.isFinite(line.carton.gsm) && line.carton.gsm > 0
      ? line.carton.gsm
      : null)

  const resolvedSheetSize = resolveSheetSize({
    specOverrides: spec,
    carton: (line?.carton || {}) as Record<string, unknown>,
    product: (line?.carton || {}) as Record<string, unknown>,
    materialQueue: (line?.materialQueue || {}) as Record<string, unknown>,
  })
  const parsedPair = parseSheetSizeToPair(resolvedSheetSize)

  if (!boardTypeRaw || !gsmRaw || !parsedPair) {
    return {
      materialId: null as string | null,
      materialCandidates: [] as Array<{ id: string; materialCode: string; description: string }>,
      boardTypeRaw: boardTypeRaw ?? null,
      boardClassificationRaw,
      gsmRaw: gsmRaw ?? null,
      resolvedSheetSize,
    }
  }

  const matches = await db.inventory.findMany({
    where: {
      active: true,
      boardType: { equals: boardTypeRaw, mode: 'insensitive' },
      ...(boardClassificationRaw
        ? { boardClassification: { equals: boardClassificationRaw, mode: 'insensitive' as const } }
        : {}),
      gsm: gsmRaw,
      sheetLength: { equals: parsedPair.length },
      sheetWidth: { equals: parsedPair.width },
    },
    select: { id: true, materialCode: true, description: true },
    take: 8,
  })

  return {
    materialId: matches.length === 1 ? matches[0]!.id : null,
    materialCandidates: matches.map((m) => ({ id: m.id, materialCode: m.materialCode, description: m.description })),
    boardTypeRaw,
    boardClassificationRaw,
    gsmRaw,
    resolvedSheetSize,
  }
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

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const ctx = await resolvePlanningContext(id)
  if ('error' in ctx) return ctx.error

  const { searchParams } = new URL(req.url)
  const selectedMaterialId = searchParams.get('materialId')?.trim() ?? ''
  const qtyOverride = parsePosInt(searchParams.get('qty'))
  const upsOverride = parsePosInt(searchParams.get('ups'))
  const wastageSheetsOverride = parsePosInt(searchParams.get('wastageSheets'))
  const gsmTolerance = Math.max(0, parsePosInt(searchParams.get('gsmTolerance')) ?? 10)
  const requirement = await calculateRequirement({ jobCardId: ctx.jobCard.id, planningId: id })
  const auto = await resolveMaterialFromSpec(ctx.line)
  const selectedMaterial =
    selectedMaterialId
      ? await db.inventory.findUnique({ where: { id: selectedMaterialId } })
      : null
  const materialId = selectedMaterial?.id ?? requirement.materialId ?? auto.materialId
  const material = selectedMaterial ?? (materialId ? await db.inventory.findUnique({ where: { id: materialId } }) : null)

  const spec = (ctx.line.specOverrides as Record<string, unknown> | null) || {}
  const core = (spec.planningCore as Record<string, unknown> | undefined) || {}
  const qtyBase = qtyOverride ?? Math.max(1, Math.floor(n(ctx.line.quantity)))
  const upsBase =
    upsOverride ??
    Math.max(1, Math.floor(n((spec.meta as Record<string, unknown> | undefined)?.ups ?? core.ups ?? 1)))
  const wastageSheets =
    wastageSheetsOverride ??
    Math.max(0, Math.floor(n(spec.wastageSheets ?? core.wastageSheets ?? 150)))
  const baseRequired = Math.max(1, Math.ceil(qtyBase / upsBase))
  const requiredSheets = Math.max(1, baseRequired + wastageSheets) || Math.max(1, Number(requirement.requiredSheets) || 0)
  const requiredSizePair = parseSheetSizeToPair(auto.resolvedSheetSize || '')
  const inventoryCandidates =
    requiredSizePair && auto.boardTypeRaw && auto.gsmRaw
      ? await db.inventory.findMany({
          where: {
            active: true,
            boardType: { equals: auto.boardTypeRaw, mode: 'insensitive' },
            ...(auto.boardClassificationRaw
              ? { boardClassification: { equals: auto.boardClassificationRaw, mode: 'insensitive' as const } }
              : {}),
            gsm: { gte: auto.gsmRaw - gsmTolerance, lte: auto.gsmRaw + gsmTolerance },
            sheetLength: { gt: 0 },
            sheetWidth: { gt: 0 },
          },
          select: {
            id: true,
            materialCode: true,
            boardType: true,
            boardClassification: true,
            gsm: true,
            qtyAvailable: true,
            sheetLength: true,
            sheetWidth: true,
          },
          take: 80,
        })
      : []
  const suggestedBoardOptions = requiredSizePair
    ? buildMaterialCutFitOptions({
        requiredLength: requiredSizePair.length,
        requiredWidth: requiredSizePair.width,
        requiredFinalSheets: requiredSheets,
        requiredGsm: auto.gsmRaw ?? null,
        config: {
          gsmTolerance,
          allowRotation: true,
          maxSuggestions: 10,
        },
        materials: inventoryCandidates.map((m) => ({
          materialId: m.id,
          materialCode: m.materialCode,
          boardType: m.boardType,
          boardClassification: m.boardClassification,
          gsm: m.gsm,
          availableParentSheets: Number(m.qtyAvailable) || 0,
          parentLength: Number(m.sheetLength) || 0,
          parentWidth: Number(m.sheetWidth) || 0,
        })),
      })
    : []
  const selectedSuggestion = selectedMaterialId
    ? suggestedBoardOptions.find((o) => o.materialId === selectedMaterialId) ?? null
    : null
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
    boardType: material?.boardType ?? auto.boardTypeRaw ?? null,
    boardClassification: material?.boardClassification ?? auto.boardClassificationRaw ?? null,
    size: (() => {
      const l = material ? formatSheetDim(material.sheetLength) : null
      const w = material ? formatSheetDim(material.sheetWidth) : null
      return l && w ? `${l}x${w}` : auto.resolvedSheetSize || null
    })(),
    gsm: material?.gsm ?? auto.gsmRaw ?? null,
    qty: qtyBase,
    ups: upsBase,
    wastageSheets,
    baseRequiredSheets: baseRequired,
    suggestedBoardOptions,
    requiredFinalSize: requiredSizePair ? `${requiredSizePair.length} x ${requiredSizePair.width}` : null,
    selectedSuggestion,
    gsmTolerance,
    requiredSheets,
    availableSheets,
    reservedSheets,
    incomingSheets,
    shortageSheets,
    prStatus: pr?.status ?? 'not_created',
    grnEta: pr?.expectedDelivery ? pr.expectedDelivery.toISOString() : null,
    status: readinessStatus(requiredSheets, availableSheets, reservedSheets, shortageSheets, Boolean(materialId)),
    materialCandidates: auto.materialCandidates,
    materialMatchState:
      materialId != null
        ? 'matched'
        : auto.materialCandidates.length > 1
          ? 'multiple'
          : auto.materialCandidates.length === 0
            ? 'none'
            : 'unknown',
  })
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const ctx = await resolvePlanningContext(id)
  if ('error' in ctx) return ctx.error
  const { line, jobCard } = ctx

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const core = (spec.planningCore as Record<string, unknown> | undefined) || {}
  const ups = Math.max(1, Math.floor(n((spec.meta as Record<string, unknown> | undefined)?.ups ?? core.ups ?? 1)))
  const body = (await req.json().catch(() => ({}))) as {
    materialId?: string
    wastageSheets?: number
    requiredSheets?: number
    cutsPerSheet?: number
    parentSize?: string
  }
  const wastageSheets = Math.max(0, Math.floor(n(body.wastageSheets ?? spec.wastageSheets ?? core.wastageSheets ?? 150)))
  const baseRequired = Math.max(1, Math.ceil(n(line.quantity) / ups))
  const computedRequired = Math.max(1, baseRequired + wastageSheets)
  const requiredSheets = Math.max(1, Math.floor(n(body.requiredSheets ?? computedRequired)))

  const requirement = await calculateRequirement({ jobCardId: jobCard.id, planningId: id })
  let materialId = requirement.materialId
  if (typeof body.materialId === 'string' && body.materialId.trim()) {
    const pick = await db.inventory.findUnique({ where: { id: body.materialId.trim() }, select: { id: true } })
    materialId = pick?.id ?? materialId
  }
  if (!materialId) {
    const auto = await resolveMaterialFromSpec(line)
    materialId = auto.materialId
  }
  if (!materialId) {
    return NextResponse.json({ error: 'No material mapped for this planning line' }, { status: 400 })
  }

  const specNow = ((line.specOverrides as Record<string, unknown> | null) || {}) as Record<string, unknown>
  const specMeta = ((specNow.meta as Record<string, unknown> | undefined) || {}) as Record<string, unknown>
  const nextSpec: Record<string, unknown> = {
    ...specNow,
    planningMaterialId: materialId,
    wastageSheets,
    meta: {
      ...specMeta,
      cutsPerSheet: Math.max(0, Math.floor(n(body.cutsPerSheet))),
      parentSize: typeof body.parentSize === 'string' ? body.parentSize.trim() : '',
    },
  }
  await db.poLineItem.update({
    where: { id },
    data: { specOverrides: nextSpec as unknown as Prisma.JsonObject },
  })

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
