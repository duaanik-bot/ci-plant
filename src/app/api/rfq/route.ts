import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { rfqSchema } from '@/lib/validations'

export const dynamic = 'force-dynamic'

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status') || undefined

  const rfqs = await db.rfq.findMany({
    where: { ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    include: {
      customer: { select: { name: true } },
    },
  })
  return NextResponse.json(rfqs)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = rfqSchema.safeParse({
    ...body,
    estimatedVolume: toOptionalNumber(body.estimatedVolume),
    cartonLength: toOptionalNumber(body.cartonLength),
    cartonWidth: toOptionalNumber(body.cartonWidth),
    cartonHeight: toOptionalNumber(body.cartonHeight),
    gsm: toOptionalNumber(body.gsm),
    numberOfColours: toOptionalNumber(body.numberOfColours),
    targetPrice: toOptionalNumber(body.targetPrice),
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json(
      { error: 'Validation failed', fields },
      { status: 400 }
    )
  }

  const count = await db.rfq.count()
  const year = new Date().getFullYear()
  const rfqNumber = `RFQ-${year}-${String(count + 1).padStart(4, '0')}`

  const rfq = await db.rfq.create({
    data: {
      rfqNumber,
      customerId: parsed.data.customerId,
      productName: parsed.data.productName,
      packType: parsed.data.packType,
      estimatedVolume: parsed.data.estimatedVolume,
      createdBy: user!.id,
      status: 'received',
    },
  })

  return NextResponse.json(rfq, { status: 201 })
}

