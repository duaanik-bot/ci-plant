import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  poLineItemId: z.string().uuid(),
  jobCardId: z.string().uuid().optional().nullable(),
  billId: z.string().uuid().optional().nullable(),
  poQty: z.number().int().positive(),
  actualQty: z.number().int().min(0),
  tolerancePct: z.number().min(0).max(100).default(2.0),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const status = req.nextUrl.searchParams.get('status') ?? 'open'

  const rows = await db.shortExcessRecord.findMany({
    where: status === 'all' ? {} : { status },
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
    orderBy: { createdAt: 'desc' },
  })

  // Enrich with bill info
  const billIds = Array.from(new Set(rows.map((r) => r.billId).filter(Boolean))) as string[]
  const bills = billIds.length
    ? await db.bill.findMany({
        where: { id: { in: billIds } },
        select: { id: true, billNumber: true },
      })
    : []
  const billMap = new Map(bills.map((b) => [b.id, b.billNumber]))

  return NextResponse.json(
    rows.map((r) => ({
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
    })),
  )
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
  const varianceQty = actualQty - poQty

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
