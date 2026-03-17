import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  status: z.string().optional(),
  feasibilityData: z.unknown().optional(),
  quotationNumber: z.string().optional(),
  quotedPrice: z.number().optional(),
  poNumber: z.string().optional(),
  poValue: z.number().optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const rfq = await db.rfq.findUnique({
    where: { id },
    include: { customer: true, creator: { select: { name: true } } },
  })
  if (!rfq) return NextResponse.json({ error: 'RFQ not found' }, { status: 404 })
  return NextResponse.json(rfq)
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const body = await req.json()
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const existing = await db.rfq.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'RFQ not found' }, { status: 404 })

  const { quotedPrice, poValue, feasibilityData, ...rest } = parsed.data
  const data: {
    status?: string
    feasibilityData?: Prisma.InputJsonValue
    quotationNumber?: string
    quotedPrice?: number
    poNumber?: string
    poValue?: number
  } = { ...rest }
  if (feasibilityData !== undefined) data.feasibilityData = feasibilityData as Prisma.InputJsonValue
  if (quotedPrice != null) data.quotedPrice = quotedPrice
  if (poValue != null) data.poValue = poValue

  const rfq = await db.rfq.update({
    where: { id },
    data,
  })

  await createAuditLog({
    userId: user?.id,
    action: 'UPDATE',
    tableName: 'rfqs',
    recordId: id,
    oldValue: { status: existing.status, quotationNumber: existing.quotationNumber, poNumber: existing.poNumber },
    newValue: { status: rfq.status, quotationNumber: rfq.quotationNumber, poNumber: rfq.poNumber },
  })

  return NextResponse.json(rfq)
}

