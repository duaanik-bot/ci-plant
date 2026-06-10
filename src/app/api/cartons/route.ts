import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { formatDimsLwhFromDb, parseCartonSizeToDims, formatDimsLwhFromParsed } from '@/lib/die-hub-dimensions'
import { masterDieTypeLabel } from '@/lib/master-die-type'
import { clampListLimit } from '@/lib/api-list-params'

export const dynamic = 'force-dynamic'

function cartonSizeFromFinished(c: {
  finishedLength: unknown
  finishedWidth: unknown
  finishedHeight: unknown
}): string {
  const l = c.finishedLength != null ? Number(c.finishedLength) : null
  const w = c.finishedWidth != null ? Number(c.finishedWidth) : null
  const h = c.finishedHeight != null ? Number(c.finishedHeight) : null
  if (l != null && w != null && h != null) return `${l}×${w}×${h}`
  if (l != null && w != null) return `${l}×${w}`
  return ''
}

function toolingDimsLabel(
  die:
    | {
        dimLengthMm: unknown
        dimWidthMm: unknown
        dimHeightMm: unknown
        cartonSize: string
      }
    | null
    | undefined,
): string {
  if (!die) return ''
  const formatted =
    formatDimsLwhFromDb({
      dimLengthMm: die.dimLengthMm as { toString(): string } | null,
      dimWidthMm: die.dimWidthMm as { toString(): string } | null,
      dimHeightMm: die.dimHeightMm as { toString(): string } | null,
    }) ??
    (parseCartonSizeToDims(die.cartonSize)
      ? formatDimsLwhFromParsed(parseCartonSizeToDims(die.cartonSize)!)
      : null)
  return formatted?.trim() || ''
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const customerId = searchParams.get('customerId')
  const qNorm = (searchParams.get('q') ?? '').trim()
  const qLower = qNorm.toLowerCase()
  const qNumber = Number(qNorm)
  const qDims = parseCartonSizeToDims(qNorm)
  const limit = clampListLimit(searchParams.get('limit'), { defaultLimit: 280, max: 500 })

  const list = await db.carton.findMany({
    where: {
      active: true,
      ...(customerId ? { customerId } : {}),
      ...(qNorm
        ? {
            OR: [
              { cartonName: { contains: qNorm, mode: 'insensitive' } },
              { artworkCode: { contains: qNorm, mode: 'insensitive' } },
              { productType: { contains: qNorm, mode: 'insensitive' } },
              { category: { contains: qNorm, mode: 'insensitive' } },
              { boardGrade: { contains: qNorm, mode: 'insensitive' } },
              { paperType: { contains: qNorm, mode: 'insensitive' } },
              { coatingType: { contains: qNorm, mode: 'insensitive' } },
              ...(Number.isFinite(qNumber)
                ? [
                    { gsm: qNumber },
                    { finishedLength: qNumber },
                    { finishedWidth: qNumber },
                    { finishedHeight: qNumber },
                  ]
                : []),
              ...(qDims
                ? [
                    {
                      AND: [
                        { finishedLength: qDims.l },
                        { finishedWidth: qDims.w },
                        { finishedHeight: qDims.h },
                      ],
                    },
                  ]
                : []),
              {
                poLineItems: {
                  some: {
                    OR: [
                      { cartonName: { contains: qNorm, mode: 'insensitive' } },
                      { artworkCode: { contains: qNorm, mode: 'insensitive' } },
                      { po: { poNumber: { contains: qNorm, mode: 'insensitive' } } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    },
    orderBy: qNorm ? { updatedAt: 'desc' } : { cartonName: 'asc' },
    take: qNorm ? Math.min(Math.max(limit, 20), 100) : limit,
    include: {
      customer: { select: { id: true, name: true } },
      poLineItems: {
        where: customerId ? { po: { customerId } } : undefined,
        orderBy: { po: { poDate: 'desc' } },
        take: 8,
        select: {
          quantity: true,
          rate: true,
          artworkCode: true,
          cartonName: true,
          po: { select: { poNumber: true, poDate: true } },
        },
      },
      dieMaster: {
        select: {
          id: true,
          dyeNumber: true,
          dyeType: true,
          pastingStyle: true,
          dimLengthMm: true,
          dimWidthMm: true,
          dimHeightMm: true,
          cartonSize: true,
        },
      },
      dye: {
        select: {
          id: true,
          dyeNumber: true,
          dyeType: true,
          pastingStyle: true,
          dimLengthMm: true,
          dimWidthMm: true,
          dimHeightMm: true,
          cartonSize: true,
        },
      },
    },
  })

  const mapped = list.map((c) => {
    const sizeText = cartonSizeFromFinished(c)
    const history = c.poLineItems
    const rates = history
      .map((h) => (h.rate != null ? Number(h.rate) : null))
      .filter((r): r is number => r != null && Number.isFinite(r))
    const last = history[0]
    const usageCount = history.length
    const exactName = qNorm && c.cartonName.toLowerCase() === qLower
    const partialText = [
      c.cartonName,
      c.artworkCode,
      c.productType,
      c.category,
      c.boardGrade,
      c.paperType,
      c.coatingType,
      c.gsm != null ? `${c.gsm}` : '',
      sizeText,
      ...history.map((h) => h.po.poNumber),
      ...history.map((h) => h.artworkCode ?? ''),
    ]
      .join(' ')
      .toLowerCase()
    const searchRank =
      (customerId && c.customerId === customerId && usageCount > 0 ? 500 : 0) +
      (usageCount > 0 ? 300 : 0) +
      (exactName ? 200 : 0) +
      (qNorm && partialText.includes(qLower) ? 100 : 0) +
      Math.min(usageCount, 25)
    const searchBadges = [
      usageCount > 0 && last ? 'Recent' : null,
      usageCount >= 5 ? 'Most Ordered' : null,
      c.sizeVerified ? 'Verified' : null,
      c.source ? 'New' : null,
      !c.active ? 'Inactive' : null,
    ].filter((x): x is string => Boolean(x))
    const dm = c.dieMaster
    const legacyDye = c.dye
    const effectiveMaster = dm ?? legacyDye
    const masterDieType = effectiveMaster
      ? masterDieTypeLabel({
          dyeType: effectiveMaster.dyeType,
          pastingStyle: effectiveMaster.pastingStyle,
        })
      : ''
    return {
      id: c.id,
      cartonName: c.cartonName,
      customerId: c.customerId,
      customer: { id: c.customer.id, name: c.customer.name },
      productType: c.productType,
      customerProductCode: c.productType ?? c.category ?? null,
      cartonSize: sizeText,
      boardGrade: c.boardGrade,
      gsm: c.gsm,
      paperType: c.paperType,
      rate: c.rate != null ? Number(c.rate) : null,
      gstPct: c.gstPct ?? 5,
      coatingType: c.coatingType,
      embossingLeafing: c.embossingLeafing,
      foilType: c.foilType,
      artworkCode: c.artworkCode,
      backPrint: c.backPrint,
      finishedLength: c.finishedLength != null ? Number(c.finishedLength) : null,
      finishedWidth: c.finishedWidth != null ? Number(c.finishedWidth) : null,
      finishedHeight: c.finishedHeight != null ? Number(c.finishedHeight) : null,
      pastingStyle: c.pastingStyle,
      drugSchedule: c.drugSchedule,
      regulatoryText: c.regulatoryText,
      specialInstructions: c.specialInstructions,
      dyeId: c.dyeId,
      dieMasterId: c.dieMasterId,
      masterDieType,
      toolingDimsLabel: toolingDimsLabel(effectiveMaster),
      toolingUnlinked: !c.dieMasterId,
      lastOrderedDate: last?.po.poDate?.toISOString() ?? null,
      lastRate: last?.rate != null ? Number(last.rate) : c.rate != null ? Number(c.rate) : null,
      usageCount,
      averageRate: rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : null,
      highestRate: rates.length ? Math.max(...rates) : null,
      lowestRate: rates.length ? Math.min(...rates) : null,
      previousOrders: history.slice(0, 8).map((h) => ({
        poNumber: h.po.poNumber,
        poDate: h.po.poDate.toISOString(),
        quantity: h.quantity,
        rate: h.rate != null ? Number(h.rate) : null,
      })),
      searchBadges,
      searchRank,
    }
  })

  return NextResponse.json(
    qNorm
      ? mapped
          .sort((a, b) => b.searchRank - a.searchRank || a.cartonName.localeCompare(b.cartonName))
          .slice(0, Math.min(limit, 100))
      : mapped,
  )
}
