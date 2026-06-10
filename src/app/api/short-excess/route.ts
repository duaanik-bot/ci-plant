import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'
import { computeAllowedQty, computeExcessQty } from '@/lib/dispatch-packing'
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
const SHORT_EXCESS_DEFAULT_LIMIT = 100
const SHORT_EXCESS_MAX_LIMIT = 300

const createSchema = z.object({
  poLineItemId: z.string().uuid(),
  jobCardId: z.string().uuid().optional().nullable(),
  billId: z.string().uuid().optional().nullable(),
  poQty: z.number().int().positive(),
  actualQty: z.number().int().min(0),
  tolerancePct: z.number().min(0).max(100).default(2.0),
})

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const { error } = await requireAuth()
  if (error) return error

  const status = req.nextUrl.searchParams.get('status') ?? 'open'
  const compact = isCompactRequest(req.nextUrl.searchParams)
  const exportRequested = isExportRequest(req.nextUrl.searchParams)
  const paged = shouldReturnPagedEnvelope(req.nextUrl.searchParams)
  const page = parseListPage(req.nextUrl.searchParams.get('page'))
  const limit = exportRequested
    ? clampListLimit(req.nextUrl.searchParams.get('limit'), { defaultLimit: SHORT_EXCESS_MAX_LIMIT, max: 5000 })
    : clampListLimit(req.nextUrl.searchParams.get('limit'), { defaultLimit: SHORT_EXCESS_DEFAULT_LIMIT, max: SHORT_EXCESS_MAX_LIMIT })
  const billId = req.nextUrl.searchParams.get('billId')?.trim()
  const jobCardId = req.nextUrl.searchParams.get('jobCardId')?.trim()
  const poLineItemId = req.nextUrl.searchParams.get('poLineItemId')?.trim()

  const rows = (await db.shortExcessRecord.findMany(
    {
      where: {
        ...(status === 'all' ? {} : { status }),
        ...(billId ? { billId } : {}),
        ...(jobCardId ? { jobCardId } : {}),
        ...(poLineItemId ? { poLineItemId } : {}),
      },
      ...(compact
        ? {
            select: {
              id: true,
              poLineItemId: true,
              jobCardId: true,
              billId: true,
              poQty: true,
              actualQty: true,
              tolerancePct: true,
              varianceQty: true,
              status: true,
              notes: true,
              closedAt: true,
              createdAt: true,
              poLineItem: {
                select: {
                  cartonName: true,
                  po: { select: { poNumber: true, customer: { select: { id: true, name: true } } } },
                },
              },
            },
          }
        : {
            include: {
              poLineItem: {
                select: {
                  id: true,
                  cartonName: true,
                  quantity: true,
                  tolerancePct: true,
                  po: {
                    select: {
                      poNumber: true,
                      customer: { select: { id: true, name: true } },
                    },
                  },
                },
              },
            },
          }),
      orderBy: { createdAt: 'desc' },
      ...(exportRequested ? {} : { take: limit, skip: listSkip(page, limit) }),
    } as any,
  )) as any[]

  // Enrich with bill info
  const billIds = Array.from(new Set(rows.map((r) => r.billId).filter(Boolean))) as string[]
  const bills = billIds.length
    ? await db.bill.findMany({
        where: { id: { in: billIds } },
        select: { id: true, billNumber: true },
      })
    : []
  const billMap = new Map(bills.map((b) => [b.id, b.billNumber]))

  const result = rows.map((r) => ({
      id: r.id,
      poLineItemId: r.poLineItemId,
      jobCardId: r.jobCardId,
      billId: r.billId,
      billNumber: r.billId ? (billMap.get(r.billId) ?? null) : null,
      poQty: r.poQty,
      actualQty: r.actualQty,
      tolerancePct: Number(r.tolerancePct),
      varianceQty: r.varianceQty,
      status: r.status,
      notes: r.notes,
      closedAt: r.closedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      cartonName: r.poLineItem.cartonName,
      poNumber: r.poLineItem.po.poNumber,
      customer: r.poLineItem.po.customer,
    }))

  logListPerformance({
    route: '/api/short-excess',
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

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    poQty: body.poQty != null ? Number(body.poQty) : undefined,
    actualQty: body.actualQty != null ? Number(body.actualQty) : undefined,
    tolerancePct: body.tolerancePct != null ? Number(body.tolerancePct) : 2.0,
  })

  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', fields: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { poLineItemId, jobCardId, billId, poQty, actualQty, tolerancePct } = parsed.data
  const upperAllowedQty = computeAllowedQty(poQty, tolerancePct)
  const lowerAllowedQty = Math.ceil(poQty * (1 - tolerancePct / 100))
  const varianceQty =
    actualQty > upperAllowedQty
      ? computeExcessQty(actualQty, upperAllowedQty)
      : actualQty < lowerAllowedQty
        ? actualQty - lowerAllowedQty
        : 0

  if (varianceQty === 0) {
    return NextResponse.json(
      { error: 'Quantity is within tolerance; no short/excess record required' },
      { status: 400 },
    )
  }

  const record = await db.shortExcessRecord.create({
    data: {
      poLineItemId,
      jobCardId: jobCardId ?? null,
      billId: billId ?? null,
      poQty,
      actualQty,
      tolerancePct,
      varianceQty,
      status: 'open',
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'short_excess_records',
    recordId: record.id,
    newValue: { poLineItemId, poQty, actualQty, varianceQty },
  })

  return NextResponse.json(record, { status: 201 })
}
