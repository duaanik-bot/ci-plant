import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { linkedMaterialRefs } from '@/lib/material-display'
import {
  clampListLimit,
  isCompactRequest,
  isExportRequest,
  listSkip,
  logListPerformance,
  parseListPage,
  shouldReturnPagedEnvelope,
} from '@/lib/api-list-params'

export const dynamic = 'force-dynamic'
const OPEN_POS_DEFAULT_LIMIT = 100
const OPEN_POS_MAX_LIMIT = 300

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const { error } = await requireAuth()
  if (error) return error
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim() ?? ''
  const compact = isCompactRequest(searchParams)
  const exportRequested = isExportRequest(searchParams)
  const paged = shouldReturnPagedEnvelope(searchParams)
  const page = parseListPage(searchParams.get('page'))
  const limit = exportRequested
    ? clampListLimit(searchParams.get('limit'), { defaultLimit: OPEN_POS_MAX_LIMIT, max: 5000 })
    : clampListLimit(searchParams.get('limit'), { defaultLimit: OPEN_POS_DEFAULT_LIMIT, max: OPEN_POS_MAX_LIMIT })

  const pos = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      isShortClosed: false,
      status: { not: 'received' },
      ...(q
        ? {
            OR: [
              { poNumber: { contains: q, mode: 'insensitive' as const } },
              { supplier: { name: { contains: q, mode: 'insensitive' as const } } },
              { material: { materialCode: { contains: q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { boardGrade: true, gsm: true, totalWeightKg: true, linkedPoLineIds: true } },
      material: { select: { materialCode: true } },
      requisitionLinks: {
        select: {
          purchaseRequisitionId: true,
          pr: { select: { materialId: true, material: { select: { materialCode: true } } } },
        },
        take: 1,
      },
    },
    orderBy: { requiredDeliveryDate: 'asc' },
    ...(exportRequested ? {} : { take: limit, skip: listSkip(page, limit) }),
  })

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const result = pos.map((po) => {
    const orderedKg = po.lines.reduce((s, l) => s + Number(l.totalWeightKg), 0)
    const receivedKg = Number(po.totalReceivedKg)
    const pendingKg = Math.max(0, orderedKg - receivedKg)

    // Resolve materialCode: direct FK first, then first linked PR's material
    const directLineRefs = po.lines.flatMap((line) => linkedMaterialRefs(line.linkedPoLineIds))
    const lineItems = po.lines.map((line) => {
      const ref = linkedMaterialRefs(line.linkedPoLineIds)[0]
      return {
        materialCode: ref?.materialCode ?? po.material?.materialCode ?? po.requisitionLinks[0]?.pr?.material?.materialCode ?? null,
        boardGrade: line.boardGrade,
        gsm: line.gsm,
        orderedKg: Number(line.totalWeightKg),
      }
    })
    const materialCodes = Array.from(
      new Set([
        po.material?.materialCode,
        po.requisitionLinks[0]?.pr?.material?.materialCode,
        ...directLineRefs.map((ref) => ref.materialCode),
      ].filter((code): code is string => !!code)),
    )
    const materialCode = materialCodes.length > 1 ? `${materialCodes[0]} +${materialCodes.length - 1}` : materialCodes[0] ?? null

    const daysOverdue = po.requiredDeliveryDate
      ? Math.floor((today.getTime() - po.requiredDeliveryDate.getTime()) / 86_400_000)
      : null

    const base = {
      id: po.id,
      poNumber: po.poNumber,
      vendorName: po.supplier.name,
      materialCode,
      orderedKg,
      receivedKg,
      pendingKg,
      requiredDeliveryDate: po.requiredDeliveryDate?.toISOString().slice(0, 10) ?? null,
      status: po.status,
      logisticsStatus: po.logisticsStatus,
      daysOverdue,
      linkedPrIds: po.requisitionLinks.map((l) => l.purchaseRequisitionId),
    }
    return compact ? base : { ...base, lineItems }
  })

  logListPerformance({
    route: '/api/inventory/paper-warehouse/open-pos',
    startedAt,
    rowCount: result.length,
    limit: exportRequested ? null : limit,
    mode: compact ? 'compact' : 'full',
    exportRequested,
  })

  if (paged) {
    return NextResponse.json({
      rows: result,
      meta: {
        page,
        limit: exportRequested ? result.length : limit,
        total: null,
        hasMore: !exportRequested && result.length === limit,
        mode: compact ? 'compact' : 'full',
      },
    })
  }

  return NextResponse.json(result)
}
