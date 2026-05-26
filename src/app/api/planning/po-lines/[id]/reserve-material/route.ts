import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import {
  calculateRequirement,
  createShortage,
  getPlanningReservedByMaterial,
  reserveMaterial,
  reserveMaterialForPlanning,
  ShortagePrRecoveryError,
} from '@/lib/material-readiness-service'
import { parseSheetSizeToPair } from '@/lib/planning-sheet-size'
import { buildMaterialCutFitOptions } from '@/lib/material-cut-fit'
import {
  resolveBoardReadiness,
  resolveMaterial as resolveMaterialState,
  resolveSheetSize,
  resolveRequirementFromLine,
  resolveReservationState,
  resolveShortageState,
} from '@/lib/production-os-resolvers'

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

function normalizeMasterValue(value: string | null | undefined): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
}

function looksLikeColorTag(value: string | null | undefined): boolean {
  const v = normalizeMasterValue(value)
  if (!v) return false
  return (
    v.includes('colour') ||
    v.includes('color') ||
    v.includes('yellow') ||
    v.includes('red') ||
    v.includes('blue') ||
    v.includes('green') ||
    v.includes('white') ||
    v.includes('black')
  )
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
  const boardTypeCandidates = [
    typeof spec.boardType === 'string' ? spec.boardType.trim() : '',
    typeof line?.materialQueue?.boardType === 'string' ? line.materialQueue.boardType.trim() : '',
    typeof line?.carton?.paperType === 'string' ? line.carton.paperType.trim() : '',
    typeof line?.paperType === 'string' ? line.paperType.trim() : '',
  ].filter(Boolean)
  const boardTypeRaw = boardTypeCandidates.find((v) => !looksLikeColorTag(v)) || boardTypeCandidates[0] || null
  const boardClassificationRaw =
    (typeof spec.boardClassification === 'string' && spec.boardClassification.trim()) ||
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
  resolved: ReturnType<typeof resolveBoardReadiness>,
): 'green' | 'yellow' | 'red' | 'grey' {
  if (resolved === 'No Material') return 'grey'
  if (resolved === 'Ready') return 'green'
  if (resolved === 'Partial') return 'yellow'
  return 'red'
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
  const materialId = resolveMaterialState({
    selectedMaterialId: selectedMaterial?.id ?? null,
    requirementMaterialId: requirement.materialId ?? null,
    autoMaterialId: auto.materialId ?? null,
  }).materialId
  const material = selectedMaterial ?? (materialId ? await db.inventory.findUnique({ where: { id: materialId } }) : null)

  const requirementFromLine = resolveRequirementFromLine({
    line: ctx.line,
    qtyOverride: qtyOverride ?? undefined,
    upsOverride: upsOverride ?? undefined,
    wastageOverride: wastageSheetsOverride ?? undefined,
  })
  const qtyBase = requirementFromLine.qty
  const upsBase = requirementFromLine.ups
  const wastageSheets = requirementFromLine.wastageSheets
  const baseRequired = requirementFromLine.baseSheets
  const requiredSheets = Math.max(requirementFromLine.requiredSheets, Math.max(1, Number(requirement.requiredSheets) || 0))
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
          attributes: true,
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

  const masterSizeRows = await db.inventory.findMany({
    where: { active: true, sheetLength: { gt: 0 }, sheetWidth: { gt: 0 } },
    select: { sheetLength: true, sheetWidth: true },
    distinct: ['sheetLength', 'sheetWidth'],
    take: 500,
  })
  const masterSheetSizes = Array.from(
    new Set(
      masterSizeRows
        .map((r) => {
          const l = Number(r.sheetLength)
          const w = Number(r.sheetWidth)
          return Number.isFinite(l) && Number.isFinite(w) && l > 0 && w > 0 ? `${l} x ${w}` : null
        })
        .filter((s): s is string => s !== null),
    ),
  )

  const boardFiltered = inventoryCandidatesAll.filter((m) => {
    if (!boardTypeNorm && !boardClassNorm) return true
    const matType = normalizeMasterValue(m.boardType)
    const matClass = normalizeMasterValue(m.boardClassification)
    const reqType = normalizeMasterValue(boardTypeNorm)
    const reqClass = normalizeMasterValue(boardClassNorm)
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
      isLeftover: String(m.materialCode || '').toUpperCase().startsWith('LEFTOVER-'),
      sourceTraceability: (() => {
        const raw = typeof m.attributes === 'string' ? m.attributes : ''
        if (!raw) return null
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          const t = parsed.traceability
          return typeof t === 'string' ? t : null
        } catch {
          return null
        }
      })(),
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
  const mergeSuggestionPools = (
    pools: Array<(typeof strictSuggestions)>,
    max = 10,
  ): typeof strictSuggestions => {
    const seen = new Set<string>()
    const merged: typeof strictSuggestions = []
    for (const pool of pools) {
      for (const opt of pool) {
        if (seen.has(opt.materialId)) continue
        seen.add(opt.materialId)
        merged.push(opt)
        if (merged.length >= max) return merged
      }
    }
    return merged
  }
  const fallbackMergedSuggestions = mergeSuggestionPools(
    [
      relaxedNoClassSuggestions,
      widerToleranceSuggestions,
      noBoardGsmSuggestions,
      noBoardWiderSuggestions,
    ],
    10,
  )
  const suggestedBoardOptions =
    strictSuggestions.length > 0
      ? strictSuggestions
      : fallbackMergedSuggestions.length > 0
        ? fallbackMergedSuggestions
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
    const derivedMatchType =
      boardMatchMode === 'fallback'
        ? 'Fallback Option'
        : opt.matchType === 'Cut Fit' && !(opt.isExactSize || opt.isNearSize)
          ? 'Compatible Size'
          : opt.matchType

    return {
      ...opt,
      boardMatchMode,
      matchType: derivedMatchType,
    }
  }
  const suggestedBoardOptionsWithMode = suggestedBoardOptions.map(withBoardMatchMode).map((opt, idx) => ({
    ...opt,
    matchRank: idx + 1,
    matchScorePct: Math.round(Math.max(0, Math.min(100, Number(opt.fitScore) || 0))),
    reason: [
      opt.matchType,
      opt.gsmDelta === 0 ? 'exact GSM' : opt.gsmDelta != null ? `${opt.gsmDelta}g off` : null,
      `${Math.round(Number(opt.yieldPct) || 0)}% yield`,
      Number(opt.shortageParentSheets) > 0 ? `short ${Math.round(Number(opt.shortageParentSheets))} sh` : 'in stock',
    ].filter(Boolean).join(' · '),
  }))

  const closestAvailableOptions =
    strictSuggestions.length === 0
      ? Array.from(byId.values())
          .slice(0, 10)
          .map((o) => withBoardMatchMode({ ...o, tags: Array.from(new Set([...(o.tags || []), 'Closest GSM' as const])) }))
          .map((o, idx) => ({
            ...o,
            matchRank: idx + 1,
            matchScorePct: Math.round(Math.max(0, Math.min(100, Number(o.fitScore) || 0))),
            reason: [
              o.matchType,
              o.gsmDelta === 0 ? 'exact GSM' : o.gsmDelta != null ? `${o.gsmDelta}g off` : null,
              `${Math.round(Number(o.yieldPct) || 0)}% yield`,
              Number(o.shortageParentSheets) > 0 ? `short ${Math.round(Number(o.shortageParentSheets))} sh` : 'in stock',
            ].filter(Boolean).join(' · '),
          }))
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
  const selectedSuggestion = selectedMaterialId
    ? suggestedBoardOptionsWithMode.find((o) => o.materialId === selectedMaterialId) ?? null
    : null
  const availableSheets = Math.max(0, Number(material?.qtyAvailable) || 0)
  const reservedSheets = Math.max(0, Number(material?.qtyReserved) || 0)
  const reservationState = resolveReservationState({
    requiredSheets,
    availableSheets,
    reservedSheets,
  })
  const freeSheets = reservationState.freeStock
  const incomingSheets = Math.max(0, Number(material?.qtyQuarantine) || 0)
  const shortageSheets = materialId
    ? resolveShortageState({
        requiredSheets,
        reserveQty: reservationState.reserveQty,
      }).shortageSheets
    : requiredSheets

  const openShortage = materialId
    ? await db.materialShortage.findFirst({
        where: {
          materialId,
          planningId: id,
          status: { in: ['open', 'closed'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, purchaseReqId: true },
      })
    : null
  let pr: { id: string; status: string; expectedDelivery: Date | null } | null = null
  if (materialId) {
    if (openShortage?.purchaseReqId) {
      pr = await db.purchaseRequisition.findUnique({
        where: { id: openShortage.purchaseReqId },
        select: { id: true, status: true, expectedDelivery: true },
      })
    }
    if (!pr) {
      pr = await db.purchaseRequisition.findFirst({
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
    }
  }

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
    makeReadySheets: requirementFromLine.makeReadySheets ?? 0,
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
    masterSheetSizes,
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
    status: readinessStatus(
      resolveBoardReadiness({
        materialSelected: Boolean(materialId),
        requiredSheets,
        availableSheets,
        reservedSheets,
        shortageSheets,
      }),
    ),
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
  const { error, user } = await requireAuth()
  if (error) return error
  const reservedByName = (user?.name || user?.email || '').trim() || undefined

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
    actionType?: 'reserve' | 'adjust' | 'ensure_shortage'
    selectedCutsPerSheet?: number
    isCutsManualOverride?: boolean
    overrideReason?: string
    leftover?: {
      addToWarehouse?: boolean
      action?: 'return_warehouse' | 'add_existing' | 'create_master' | 'reserve_another_job' | 'scrap' | null
      leftoverLength?: number
      leftoverWidth?: number
      leftoverQty?: number
      leftoverRemarks?: string
      cutSizeUsed?: string
      reserveForPlanningId?: string | null
      reserveForJobCardId?: string | null
    }
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
  const auto = await resolveMaterialFromSpec(line)
  let materialId = requirement.materialId
  if (typeof body.materialId === 'string' && body.materialId.trim()) {
    const pick = await db.inventory.findUnique({ where: { id: body.materialId.trim() }, select: { id: true } })
    materialId = pick?.id ?? materialId
  }
  if (!materialId) {
    materialId = auto.materialId
  }

  // --- ensure_shortage branch ---
  // Creates (or upserts) a materialShortage record for this line without
  // reserving any stock. Used by "Raise PR" when no shortageId yet exists.
  if (body.actionType === 'ensure_shortage') {
    if (!materialId) {
      return reserveError(400, 'NO_MATERIAL', 'No material selected — cannot create shortage', {
        planningLineId: id,
        requestedMaterialId: typeof body.materialId === 'string' ? body.materialId.trim() : null,
      })
    }
    // Compute how many sheets are free (available minus already-reserved-for-this-line)
    const material = await db.inventory.findUnique({ where: { id: materialId }, select: { qtyAvailable: true } })
    const availableSheets = Math.max(0, Number(material?.qtyAvailable) || 0)
    const alreadyReservedMap = await getPlanningReservedByMaterial(id, [materialId])
    const alreadyReserved = Math.max(0, Number(alreadyReservedMap[materialId] || 0))
    const freeForMaterial = Math.max(0, availableSheets - alreadyReserved)
    const deficit = Math.max(0, requiredSheets - freeForMaterial)
    if (deficit <= 0) {
      // Stock is sufficient — no shortage record needed
      return NextResponse.json({ shortageId: null, deficit: 0 })
    }
    try {
      const shortage = await createShortage(materialId, jobCard?.id ?? null, id, deficit)
      return NextResponse.json({ shortageId: shortage.id, deficit })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create shortage record'
      return reserveError(500, 'UNKNOWN', msg, { planningLineId: id, materialId, deficit })
    }
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

  const cutsPerSheet = Math.max(0, Number(n(body.selectedCutsPerSheet || body.cutsPerSheet).toFixed(4)))
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
      calculatedCutsPerSheet: Number(n(body.cutsPerSheet).toFixed(4)),
      selectedCutsPerSheet: cutsPerSheet,
      isCutsManualOverride: Boolean(body.isCutsManualOverride),
      cutsOverrideReason:
        typeof body.overrideReason === 'string' && body.overrideReason.trim()
          ? body.overrideReason.trim()
          : null,
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
      ? await reserveMaterial(materialId, jobCard.id, requiredSheets, id, null, db, reservedByName)
      : await reserveMaterialForPlanning(materialId, requiredSheets, id, null, db, reservedByName)
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
    console.error('Planning reserve failed', {
      failingFunction: 'reserveMaterialForPlanning/reserveMaterial',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      payload: {
        planningLineId: id,
        materialId,
        requiredParentSheets: n(body.requiredParentSheets),
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

  let leftoverMaterialId: string | null = null
  let futureReservationId: string | null = null
  const reserveLeftoverForAnotherJob = body.leftover?.action === 'reserve_another_job'
  if (body.leftover?.addToWarehouse || reserveLeftoverForAnotherJob) {
    const leftoverLength = Math.max(0, Number(n(body.leftover.leftoverLength).toFixed(4)))
    const leftoverWidth = Math.max(0, Number(n(body.leftover.leftoverWidth).toFixed(4)))
    const leftoverQty = Math.max(0, Number(n(body.leftover.leftoverQty).toFixed(3)))
    if (leftoverLength > 0 && leftoverWidth > 0 && leftoverQty > 0) {
      const sourceMaterial = await db.inventory.findUnique({
        where: { id: materialId },
        select: {
          materialCode: true,
          boardType: true,
          boardClassification: true,
          gsm: true,
          unit: true,
          weightedAvgCost: true,
          supplierId: true,
          category: true,
          storageLocation: true,
        },
      })
      const gsm = Number(sourceMaterial?.gsm ?? auto.gsmRaw ?? 0)
      const leftoverWeightKg = Number(((leftoverLength * leftoverWidth * gsm * leftoverQty) / 1000000).toFixed(6))
      const forceNewMaster = body.leftover.action === 'create_master'
      const reserveRefId =
        (typeof body.leftover.reserveForPlanningId === 'string' && body.leftover.reserveForPlanningId.trim()) ||
        (typeof body.leftover.reserveForJobCardId === 'string' && body.leftover.reserveForJobCardId.trim()) ||
        id
      const reserveRefType =
        typeof body.leftover.reserveForJobCardId === 'string' && body.leftover.reserveForJobCardId.trim()
          ? 'future_job_reserve'
          : typeof body.leftover.reserveForPlanningId === 'string' && body.leftover.reserveForPlanningId.trim()
            ? 'future_planning_reserve'
            : 'future_job_hold'
      const matchingStock = forceNewMaster
        ? null
        : await db.inventory.findFirst({
            where: {
              active: true,
              boardType: sourceMaterial?.boardType || auto.boardTypeRaw || undefined,
              boardClassification: sourceMaterial?.boardClassification || auto.boardClassificationRaw || undefined,
              sheetLength: leftoverLength,
              sheetWidth: leftoverWidth,
              gsm: sourceMaterial?.gsm ?? auto.gsmRaw ?? undefined,
              supplierId: sourceMaterial?.supplierId || undefined,
            },
            select: { id: true },
          })
      if (matchingStock) {
        const updated = await db.inventory.update({
          where: { id: matchingStock.id },
          data: reserveLeftoverForAnotherJob
            ? {
                qtyReserved: { increment: leftoverQty },
                physicalStockSheets: { increment: leftoverQty },
                totalWeightKg: { increment: leftoverWeightKg },
              }
            : {
                qtyAvailable: { increment: leftoverQty },
                physicalStockSheets: { increment: leftoverQty },
                totalWeightKg: { increment: leftoverWeightKg },
              },
          select: { id: true },
        })
        leftoverMaterialId = updated.id
        const movement = await db.stockMovement.create({
          data: {
            materialId: updated.id,
            movementType: reserveLeftoverForAnotherJob ? 'future_reserve' : 'leftover_merge',
            qty: leftoverQty,
            refType: reserveLeftoverForAnotherJob ? reserveRefType : 'planning_leftover',
            refId: reserveLeftoverForAnotherJob ? reserveRefId : id,
          },
          select: { id: true },
        })
        if (reserveLeftoverForAnotherJob) futureReservationId = movement.id
      } else {
      const codeSeed = (sourceMaterial?.materialCode || materialId).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'MAT'
      const sizeCode = `${leftoverLength}x${leftoverWidth}`.replace(/[^0-9x]/g, '')
      const leftoverCode = `LEFTOVER-${codeSeed}-${sizeCode}-${Date.now().toString().slice(-6)}`
      const attributes = JSON.stringify({
        leftover: true,
        sourceMaterialId: materialId,
        sourcePlanningId: id,
        sourceJobCardId: jobCard?.id ?? null,
        sourceParentSize: parentSize,
        cutSizeUsed: body.leftover.cutSizeUsed || auto.resolvedSheetSize || null,
        remarks: body.leftover.leftoverRemarks || null,
        balanceAction: body.leftover.action || null,
        reservedForFuture: reserveLeftoverForAnotherJob,
        futureReservationRefType: reserveLeftoverForAnotherJob ? reserveRefType : null,
        futureReservationRefId: reserveLeftoverForAnotherJob ? reserveRefId : null,
        traceability: `Leftover generated from Planning Line ${id} / Material ${sourceMaterial?.materialCode || materialId}`,
      })
      const created = await db.inventory.create({
        data: {
          materialCode: leftoverCode,
          description: `Leftover stock ${leftoverLength}x${leftoverWidth}`,
          boardType: sourceMaterial?.boardType || auto.boardTypeRaw || null,
          boardClassification: sourceMaterial?.boardClassification || auto.boardClassificationRaw || null,
          sheetLength: leftoverLength,
          sheetWidth: leftoverWidth,
          gsm: sourceMaterial?.gsm ?? auto.gsmRaw ?? null,
          attributes,
          unit: sourceMaterial?.unit || 'sheets',
          supplierId: sourceMaterial?.supplierId || null,
          category: sourceMaterial?.category || 'C',
          qtyAvailable: reserveLeftoverForAnotherJob ? 0 : leftoverQty,
          qtyReserved: reserveLeftoverForAnotherJob ? leftoverQty : 0,
          physicalStockSheets: leftoverQty,
          totalWeightKg: leftoverWeightKg,
          weightedAvgCost: sourceMaterial?.weightedAvgCost || 0,
          storageLocation: sourceMaterial?.storageLocation || 'LEFTOVER',
          active: true,
        },
        select: { id: true },
      })
      leftoverMaterialId = created.id
      const movement = await db.stockMovement.create({
        data: {
          materialId: created.id,
          movementType: reserveLeftoverForAnotherJob ? 'future_reserve' : 'leftover_create',
          qty: leftoverQty,
          refType: reserveLeftoverForAnotherJob ? reserveRefType : 'planning_leftover',
          refId: reserveLeftoverForAnotherJob ? reserveRefId : id,
        },
        select: { id: true },
      })
      if (reserveLeftoverForAnotherJob) futureReservationId = movement.id
      }
    }
  }

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
    leftoverMaterialId,
    futureReservationId,
  })
}
