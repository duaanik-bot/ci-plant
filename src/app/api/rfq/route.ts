import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  customerId: z.string().uuid(),
  productName: z.string().min(1),
  packType: z.string().min(1),
  estimatedVolume: z.number().int().optional(),
})

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

  const body = await req.json()
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
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

