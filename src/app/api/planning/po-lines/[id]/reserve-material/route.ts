import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { calculateRequirement, reserveMaterial, reserveMaterialForPlanning, ShortagePrRecoveryError } from '@/lib/material-readiness-service'
import { parseSheetSizeToPair, resolveSheetSize } from '@/lib/planning-sheet-size'
import { buildMaterialCutFitOptions } from '@/lib/material-cut-fit'

export const dynamic = 'force-dynamic'

type ReserveErrorCode = 'STOCK_CHANGED' | 'NO_MATERIAL' | 'INVALID_INPUT' | 'CONTEXT_MISSING' | 'UNKNOWN'

function reserveError(
  status: number,
  errorCode: ReserveErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  const includeDebug = process.env.NODE_ENV !== 'production' || process.env.CI_TRIAL_MODE === '1'
  return NextResponse.json(
    {
      success: false,
      errorCode,
      message,
      ...(includeDebug ? { debugMessage: typeof details?.rawError === 'string' ? details.rawError : undefined } : {}),
      ...(includeDebug ? { failingFunction: 'planning.reserve-material.POST' } : {}),
      ...(details ? { details } : {}),
    },
    { status },
  )
}

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

function normalizeText(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

async function getPlanningReservedByMaterial(
  planningLineId: string,
  materialIds: string[],
): Promise<Record<string, number>> {
  if (!planningLineId || materialIds.length === 0) return {}
  const rows = await db.stockMovement.findMany({
    where: {
      refId: planningLineId,
      materialId: { in: materialIds },
      refType: {
        in: ['planning_reserve', 'planning_adjust_increase', 'planning_release', 'planning_adjust_decrease'],
      },
    },
    select: {
      materialId: true,
      refType: true,
      qty: true,
    },
  })
  const out: Record<string, number> = {}
  for (const row of rows) {
    const qty = Number(row.qty) || 0
    const sign =
      row.refType === 'planning_release' || row.refType === 'planning_adjust_decrease'
        ? -1
        : 1
    out[row.materialId] = Math.max(0, (out[row.materialId] || 0) + sign * qty)
  }
  return out
}

async function resolvePlanningContext(id: string, opts?: { requireJobCard?: boolean }) {
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
  if (opts?.requireJobCard !== false && !jobCard) {
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

  const boardTypeNorm = boardTypeRaw.trim()
  const boardClassificationNorm = boardClassificationRaw?.trim() || null
  const matches = await db.inventory.findMany({
    where: {
      active: true,
      OR: [
        { boardType: { equals: boardTypeNorm, mode: 'insensitive' } },
        { boardClassification: { equals: boardTypeNorm, mode: 'insensitive' } },
        ...(boardClassificationNorm
          ? [
              { boardType: { equals: boardClassificationNorm, mode: 'insensitive' as const } },
              { boardClassification: { equals: boardClassificationNorm, mode: 'insensitive' as const } },
            ]
          : []),
      ],
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
  const ctx = await resolvePlanningContext(id, { requireJobCard: false })
  if ('error' in ctx) return ctx.error

  const { searchParams } = new URL(req.url)
  const selectedMaterialId = searchParams.get('materialId')?.trim() ?? ''
  const qtyOverride = parsePosInt(searchParams.get('qty'))
  const upsOverride = parsePosInt(searchParams.get('ups'))
  const wastageSheetsOverride = parsePosInt(searchParams.get('wastageSheets'))
  const gsmTolerance = Math.max(0, parsePosInt(searchParams.get('gsmTolerance')) ?? 10)
  const requirement = ctx.jobCard
    ? await calculateRequirement({ jobCardId: ctx.jobCard.id, planningId: id })
    : {
        requiredSheets: 0,
        materialId: null,
      }
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
  const boardTypeNorm = auto.boardTypeRaw?.trim() || null
  const boardClassNorm = auto.boardClassificationRaw?.trim() || null
  const baseInventoryWhere = {
    active: true,
    sheetLength: { gt: 0 },
    sheetWidth: { gt: 0 },
  }
  const inventoryCandidatesAll = requiredSizePair
    ? await db.inventory.findMany({
        where: baseInventoryWhere,
        select: {
          id: true,
          materialCode: true,
          boardType: true,
          boardClassification: true,
          gsm: true,
          qtyAvailable: true,
          qtyReserved: true,
          sheetLength: true,
          sheetWidth: true,
        },
        take: 200,
      })
    : []

  const boardFiltered = inventoryCandidatesAll.filter((m) => {
    if (!boardTypeNorm && !boardClassNorm) return true
    const matType = normalizeText(m.boardType)
    const matClass = normalizeText(m.boardClassification)
    const reqType = normalizeText(boardTypeNorm)
    const reqClass = normalizeText(boardClassNorm)
    return (
      (!!reqType && (matType === reqType || matClass === reqType)) ||
      (!!reqClass && (matType === reqClass || matClass === reqClass))
    )
  })
  const withClassification = boardFiltered.filter((m) => {
    if (!auto.boardClassificationRaw) return true
    const target = auto.boardClassificationRaw.trim().toLowerCase()
    return (
      (m.boardClassification || '').trim().toLowerCase() === target ||
      (m.boardType || '').trim().toLowerCase() === target
    )
  })
  const gsmWithin = (rows: typeof inventoryCandidatesAll, tolerance: number) =>
    rows.filter((m) => {
      if (auto.gsmRaw == null || m.gsm == null) return true
      return Math.abs(Number(m.gsm) - Number(auto.gsmRaw)) <= tolerance
    })

  const strictSet = gsmWithin(withClassification, gsmTolerance)
  const relaxedNoClassSet = gsmWithin(boardFiltered, gsmTolerance)
  const widerTolerance = Math.max(gsmTolerance, 20)
  const widerToleranceSet = gsmWithin(boardFiltered, widerTolerance)
  const noBoardGsmSet = gsmWithin(inventoryCandidatesAll, gsmTolerance)
  const noBoardWiderSet = gsmWithin(inventoryCandidatesAll, widerTolerance)
  const toCutFitInput = (rows: typeof inventoryCandidatesAll) =>
    rows.map((m) => ({
      materialId: m.id,
      materialCode: m.materialCode,
      boardType: m.boardType,
      boardClassification: m.boardClassification,
      gsm: m.gsm,
      availableParentSheets: Number(m.qtyAvailable) || 0,
      reservedParentSheets: Number(m.qtyReserved) || 0,
      parentLength: Number(m.sheetLength) || 0,
      parentWidth: Number(m.sheetWidth) || 0,
    }))
  const strictSuggestions = requiredSizePair
    ? buildMaterialCutFitOptions({
        requiredLength: requiredSizePair.length,
        requiredWidth: requiredSizePair.width,
        requiredFinalSheets: requiredSheets,
        requiredGsm: auto.gsmRaw ?? null,
        config: { gsmTolerance, allowRotation: true, maxSuggestions: 10 },
        materials: toCutFitInput(strictSet),
      })
    : []
  const relaxedNoClassSuggestions = requiredSizePair
    ? buildMaterialCutFitOptions({
        requiredLength: requiredSizePair.length,
        requiredWidth: requiredSizePair.width,
        requiredFinalSheets: requiredSheets,
        requiredGsm: auto.gsmRaw ?? null,
        config: { gsmTolerance, allowRotation: true, maxSuggestions: 10 },
        materials: toCutFitInput(relaxedNoClassSet),
      })
    : []
  const widerToleranceSuggestions = requiredSizePair
    ? buildMaterialCutFitOptions({
        requiredLength: requiredSizePair.length,
        requiredWidth: requiredSizePair.width,
        requiredFinalSheets: requiredSheets,
        requiredGsm: auto.gsmRaw ?? null,
        config: { gsmTolerance: widerTolerance, allowRotation: true, maxSuggestions: 10 },
        materials: toCutFitInput(widerToleranceSet),
      })
    : []
  const noBoardGsmSuggestions = requiredSizePair
    ? buildMaterialCutFitOptions({
        requiredLength: requiredSizePair.length,
        requiredWidth: requiredSizePair.width,
        requiredFinalSheets: requiredSheets,
        requiredGsm: auto.gsmRaw ?? null,
        config: { gsmTolerance, allowRotation: true, maxSuggestions: 10 },
        materials: toCutFitInput(noBoardGsmSet),
      })
    : []
  const noBoardWiderSuggestions = requiredSizePair
    ? buildMaterialCutFitOptions({
        requiredLength: requiredSizePair.length,
        requiredWidth: requiredSizePair.width,
        requiredFinalSheets: requiredSheets,
        requiredGsm: auto.gsmRaw ?? null,
        config: { gsmTolerance: widerTolerance, allowRotation: true, maxSuggestions: 10 },
        materials: toCutFitInput(noBoardWiderSet),
      })
    : []
  const byId = new Map<string, (typeof strictSuggestions)[number]>()
  for (const s of [
    ...strictSuggestions,
    ...relaxedNoClassSuggestions,
    ...widerToleranceSuggestions,
    ...noBoardGsmSuggestions,
    ...noBoardWiderSuggestions,
  ]) {
    if (!byId.has(s.materialId)) byId.set(s.materialId, s)
  }
  const suggestedBoardOptions =
    strictSuggestions.length > 0
      ? strictSuggestions
      : relaxedNoClassSuggestions.length > 0
        ? relaxedNoClassSuggestions
        : widerToleranceSuggestions.length > 0
          ? widerToleranceSuggestions
          : noBoardGsmSuggestions.length > 0
            ? noBoardGsmSuggestions
            : noBoardWiderSuggestions.length > 0
              ? noBoardWiderSuggestions
          : Array.from(byId.values()).slice(0, 10).map((o) => ({ ...o, matchType: o.matchType, status: o.status }))

  const withBoardMatchMode = (opt: (typeof suggestedBoardOptions)[number]) => {
    const reqType = normalizeText(auto.boardTypeRaw)
    const reqClass = normalizeText(auto.boardClassificationRaw)
    const matType = normalizeText(opt.boardType)
    const matClass = normalizeText(opt.boardClassification)
    const isTypeExact = !!reqType && matType === reqType
    const isTypeViaClass = !!reqType && matClass === reqType
    const isClassViaType = !!reqClass && matType === reqClass
    const isClassExact = !!reqClass && matClass === reqClass
    const boardMatchMode =
      isTypeExact || isClassExact
        ? 'exact'
        : isTypeViaClass || isClassViaType
          ? 'cross_field'
          : 'fallback'
    return {
      ...opt,
      boardMatchMode,
    }
  }
  const suggestedBoardOptionsWithMode = suggestedBoardOptions.map(withBoardMatchMode)
  suggestedBoardOptionsWithMode.forEach((opt, idx) => {
    console.log('[cutfit-ranking-debug]', {
      rank: idx + 1,
      materialId: opt.materialId,
      materialCode: opt.materialCode,
      size: opt.size,
      cuts: opt.cutsPerSheet,
      wastagePct: opt.wastagePct,
      sizeDiff: (opt as { sizeDiff?: number }).sizeDiff ?? null,
      gsmDelta: opt.gsmDelta ?? null,
      freeStock: (opt as { freeSheets?: number }).freeSheets ?? null,
      matchType: opt.matchType,
    })
  })

  const closestAvailableOptions =
    strictSuggestions.length === 0
      ? Array.from(byId.values())
          .slice(0, 10)
          .map((o) => ({ ...o, tags: Array.from(new Set([...(o.tags || []), 'Closest GSM' as const])) }))
      : []
  const candidateMaterialIds = Array.from(
    new Set(
      [
        ...(suggestedBoardOptionsWithMode || []).map((o) => o.materialId),
        ...(closestAvailableOptions || []).map((o) => o.materialId),
        materialId || '',
      ].filter(Boolean),
    ),
  )
  const reservedByMaterial = await getPlanningReservedByMaterial(id, candidateMaterialIds)
  const noMaterialsAtAll = inventoryCandidatesAll.length === 0
  const debug = {
    requiredSize: requiredSizePair ? `${requiredSizePair.length}x${requiredSizePair.width}` : null,
    requiredGsm: auto.gsmRaw ?? null,
    tolerance: gsmTolerance,
    boardType: auto.boardTypeRaw ?? null,
    boardClassification: auto.boardClassificationRaw ?? null,
    materialsFetched: inventoryCandidatesAll.length,
    boardFiltered: boardFiltered.length,
    afterGsmFilter: strictSet.length,
    afterSizeFit: strictSuggestions.length,
    finalSuggestions: suggestedBoardOptions.length,
    fallbackWithoutClassification: relaxedNoClassSuggestions.length,
    fallbackWithWiderTolerance: widerToleranceSuggestions.length,
    fallbackNoBoardGsm: noBoardGsmSuggestions.length,
    fallbackNoBoardWider: noBoardWiderSuggestions.length,
  }
  console.log('[planning-cutfit-debug]', debug)
  const selectedSuggestion = selectedMaterialId
    ? suggestedBoardOptionsWithMode.find((o) => o.materialId === selectedMaterialId) ?? null
    : null
  const availableSheets = Math.max(0, Number(material?.qtyAvailable) || 0)
  const reservedSheets = Math.max(0, Number(material?.qtyReserved) || 0)
  const freeSheets = availableSheets - reservedSheets
  const incomingSheets = Math.max(0, Number(material?.qtyQuarantine) || 0)
  const shortageSheets = materialId ? Math.max(0, requiredSheets - Math.max(0, freeSheets)) : requiredSheets

  const pr = materialId
    ? await db.purchaseRequisition.findFirst({
        where: {
          materialId,
          OR: [
            ...(ctx.jobCard ? [{ sourceJobCardId: ctx.jobCard.id }] : []),
            { sourcePlanningId: id },
          ],
        },
        orderBy: { raisedAt: 'desc' },
        select: { id: true, status: true, expectedDelivery: true },
      })
    : null
  const openShortage = materialId
    ? await db.materialShortage.findFirst({
        where: {
          materialId,
          planningId: id,
          status: 'open',
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
    : null

  return NextResponse.json({
    planningId: id,
    jobCardId: ctx.jobCard?.id ?? null,
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
    suggestedBoardOptions: suggestedBoardOptionsWithMode,
    closestAvailableOptions,
    reservedByMaterial,
    reservedForLine: materialId ? Math.max(0, Number(reservedByMaterial[materialId] || 0)) : 0,
    noMaterialsAtAll,
    debugMessage:
      suggestedBoardOptions.length === 0 && !noMaterialsAtAll
        ? 'No strict match found. Showing closest available materials.'
        : null,
    requiredFinalSize: requiredSizePair ? `${requiredSizePair.length} x ${requiredSizePair.width}` : null,
    selectedSuggestion,
    gsmTolerance,
    requiredSheets,
    availableSheets,
    reservedSheets,
    freeSheets,
    incomingSheets,
    shortageSheets,
    prId: pr?.id ?? null,
    prStatus: pr?.status ?? 'not_created',
    grnEta: pr?.expectedDelivery ? pr.expectedDelivery.toISOString() : null,
    shortageId: openShortage?.id ?? null,
    linkedShortageId: openShortage?.id ?? null,
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
    suggestionDebug: debug,
    mappingSafety: {
      requestedBoardType: auto.boardTypeRaw ?? null,
      requestedBoardClassification: auto.boardClassificationRaw ?? null,
      candidatePoolCount: inventoryCandidatesAll.length,
      strictPoolCount: strictSet.length,
      strategyUsed:
        strictSuggestions.length > 0
          ? 'strict'
          : relaxedNoClassSuggestions.length > 0
            ? 'fallback_without_classification'
            : widerToleranceSuggestions.length > 0
              ? 'fallback_wider_gsm_tolerance'
              : 'closest_only',
    },
  })
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const ctx = await resolvePlanningContext(id, { requireJobCard: false })
  if ('error' in ctx) return ctx.error
  const { line, jobCard } = ctx
  if (!line?.id) {
    return reserveError(400, 'CONTEXT_MISSING', 'Planning context missing', { planningLineId: id || null })
  }

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const core = (spec.planningCore as Record<string, unknown> | undefined) || {}
  const ups = Math.max(1, Math.floor(n((spec.meta as Record<string, unknown> | undefined)?.ups ?? core.ups ?? 1)))
  const body = (await req.json().catch(() => ({}))) as {
    materialId?: string
    wastageSheets?: number
    requiredSheets?: number
    requiredParentSheets?: number
    reserveQty?: number
    shortageQty?: number
    prQty?: number
    cutsPerSheet?: number
    parentSize?: string
    actionType?: 'reserve' | 'adjust'
  }
  const wastageSheets = Math.max(0, Math.floor(n(body.wastageSheets ?? spec.wastageSheets ?? core.wastageSheets ?? 150)))
  const baseRequired = Math.max(1, Math.ceil(n(line.quantity) / ups))
  const computedRequired = Math.max(1, baseRequired + wastageSheets)
  const requiredSheets = Math.max(1, Math.floor(n(body.requiredParentSheets ?? body.requiredSheets ?? computedRequired)))
  if (!requiredSheets || requiredSheets <= 0) {
    return reserveError(400, 'INVALID_INPUT', 'Invalid calculation data', {
      requiredSheets,
      planningLineId: id,
    })
  }

  const requirement = jobCard
    ? await calculateRequirement({ jobCardId: jobCard.id, planningId: id })
    : { materialId: null as string | null }
  let materialId = requirement.materialId
  if (typeof body.materialId === 'string' && body.materialId.trim()) {
    const pick = await db.inventory.findUnique({ where: { id: body.materialId.trim() }, select: { id: true } })
    materialId = pick?.id ?? materialId
  }
  if (!materialId) {
    const auto = await resolveMaterialFromSpec(line)
    materialId = auto.materialId
  }

  const actionType = body.actionType === 'adjust' ? 'adjust' : 'reserve'
  if (actionType !== 'adjust') {
    const alreadyReservedMap = await getPlanningReservedByMaterial(id, [materialId])
    const alreadyReserved = Math.max(0, Number(alreadyReservedMap[materialId] || 0))
    if (alreadyReserved > 0) {
      return reserveError(
        409,
        'INVALID_INPUT',
        'Material already reserved for this planning line. Use Adjust Reservation.',
        {
          planningLineId: id,
          materialId,
          reservedForLine: alreadyReserved,
        },
      )
    }
  }
  if (!materialId) {
    return reserveError(400, 'NO_MATERIAL', 'No material selected', {
      planningLineId: id,
      requestedMaterialId: typeof body.materialId === 'string' ? body.materialId.trim() : null,
    })
  }

  const cutsPerSheet = Math.max(0, Math.floor(n(body.cutsPerSheet)))
  const parentSize = typeof body.parentSize === 'string' ? body.parentSize.trim() : ''
  if (!cutsPerSheet || !parentSize) {
    return reserveError(400, 'INVALID_INPUT', 'Invalid calculation data', {
      cutsPerSheet,
      parentSize,
      requiredSheets,
      planningLineId: id,
      materialId,
    })
  }

  const specNow = ((line.specOverrides as Record<string, unknown> | null) || {}) as Record<string, unknown>
  const specMeta = ((specNow.meta as Record<string, unknown> | undefined) || {}) as Record<string, unknown>
  const nextSpec: Record<string, unknown> = {
    ...specNow,
    planningMaterialId: materialId,
    wastageSheets,
    meta: {
      ...specMeta,
      cutsPerSheet,
      parentSize,
    },
  }
  await db.poLineItem.update({
    where: { id },
    data: { specOverrides: nextSpec as unknown as Prisma.JsonObject },
  })

  let result:
    | Awaited<ReturnType<typeof reserveMaterial>>
    | Awaited<ReturnType<typeof reserveMaterialForPlanning>>
  try {
    result = jobCard
      ? await reserveMaterial(materialId, jobCard.id, requiredSheets, id)
      : await reserveMaterialForPlanning(materialId, requiredSheets, id)
  } catch (error) {
    if (error instanceof ShortagePrRecoveryError) {
      return NextResponse.json(
        {
          success: false,
          errorCode: 'UNKNOWN',
          message: error.message,
          error: error.message,
          retryable: true,
          shortageId: error.shortageId,
          action: 'create_pr_for_shortage',
        },
        { status: 409 },
      )
    }
    console.error('[planning-reserve-debug]', {
      failingFunction: 'reserveMaterialForPlanning/reserveMaterial',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      errorStack: error instanceof Error ? error.stack : null,
      payload: {
        planningLineId: id,
        poLineId: id,
        materialId,
        cutsPerSheet,
        requiredParentSheets: n(body.requiredParentSheets),
        reserveQty: n(body.reserveQty),
        shortageQty: n(body.shortageQty),
        prQty: n(body.prQty),
        selectedOptionData: {
          parentSize,
          requiredSheets,
          wastageSheets,
        },
      },
    })
    const message = error instanceof Error ? error.message : 'Reservation failed. Please try again'
    const normalized = message.toLowerCase()
    if (
      normalized.includes('stock changed') ||
      normalized.includes('available stock changed') ||
      normalized.includes('concurrent')
    ) {
      return reserveError(409, 'STOCK_CHANGED', 'Stock changed. Please refresh and reserve again', {
        planningLineId: id,
        materialId,
        requiredSheets,
      })
    }
    if (normalized.includes('material') && normalized.includes('missing')) {
      return reserveError(400, 'NO_MATERIAL', 'No material selected', {
        planningLineId: id,
        materialId,
      })
    }
    if (normalized.includes('planning') && normalized.includes('missing')) {
      return reserveError(400, 'CONTEXT_MISSING', 'Planning context missing', {
        planningLineId: id,
      })
    }
    return reserveError(500, 'UNKNOWN', 'Reservation failed. Please try again', {
      planningLineId: id,
      materialId,
      requiredSheets,
      rawError: message,
    })
  }

  const shortageId =
    'shortage' in result &&
    result.shortage &&
    typeof result.shortage === 'object' &&
    'id' in result.shortage &&
    typeof (result.shortage as { id?: unknown }).id === 'string'
      ? (result.shortage as { id: string }).id
      : null

  return NextResponse.json({
    success: true,
    planningId: id,
    jobCardId: jobCard?.id ?? null,
    materialId,
    requiredSheets,
    reservedSheets: result.reservedSheets,
    shortageSheets: result.shortageSheets,
    status: result.status,
    purchaseRequestId: result.purchaseRequest?.id ?? null,
    shortageId,
    linkedShortageId: shortageId,
  })
}
