import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  cartonName: z.string().min(1, 'Carton name is required'),
  customerId: z.string().uuid('Customer is required'),
  productType: z.string().optional(),
  category: z.string().optional(),
  rate: z.number().min(0).optional(),
  gstPct: z.number().int().min(0).max(28).default(12),
  active: z.boolean().default(true),
  boardGrade: z.string().optional(),
  gsm: z.number().int().optional(),
  caliperMicrons: z.number().int().optional(),
  paperType: z.string().optional(),
  plyCount: z.number().int().min(1).max(3).optional(),
  finishedLength: z.number().positive().optional(),
  finishedWidth: z.number().positive().optional(),
  finishedHeight: z.number().positive().optional(),
  coatingType: z.string().optional(),
  embossingLeafing: z.string().optional(),
  foilType: z.string().optional(),
  artworkCode: z.string().optional(),
  backPrint: z.string().optional(),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.carton.findMany({
    include: { customer: { select: { id: true, name: true } } },
    orderBy: { cartonName: 'asc' },
  })
  return NextResponse.json(
    list.map((c) => ({
      ...c,
      rate: c.rate != null ? Number(c.rate) : null,
      burstStrengthMin: c.burstStrengthMin != null ? Number(c.burstStrengthMin) : null,
      moistureMaxPct: c.moistureMaxPct != null ? Number(c.moistureMaxPct) : null,
      finishedLength: c.finishedLength != null ? Number(c.finishedLength) : null,
      finishedWidth: c.finishedWidth != null ? Number(c.finishedWidth) : null,
      finishedHeight: c.finishedHeight != null ? Number(c.finishedHeight) : null,
    }))
  )
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    rate: body.rate != null ? Number(body.rate) : undefined,
    gstPct: body.gstPct != null ? Number(body.gstPct) : 12,
    finishedLength: body.finishedLength != null ? Number(body.finishedLength) : undefined,
    finishedWidth: body.finishedWidth != null ? Number(body.finishedWidth) : undefined,
    finishedHeight: body.finishedHeight != null ? Number(body.finishedHeight) : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data

  const carton = await db.carton.create({
    data: {
      cartonName: data.cartonName.trim(),
      customerId: data.customerId,
      productType: data.productType || null,
      category: data.category || null,
      rate: data.rate ?? null,
      gstPct: data.gstPct,
      active: data.active,
      boardGrade: data.boardGrade || null,
      gsm: data.gsm ?? null,
      caliperMicrons: data.caliperMicrons ?? null,
      paperType: data.paperType || null,
      plyCount: data.plyCount ?? 1,
      finishedLength: data.finishedLength ?? null,
      finishedWidth: data.finishedWidth ?? null,
      finishedHeight: data.finishedHeight ?? null,
      coatingType: data.coatingType || null,
      embossingLeafing: data.embossingLeafing || null,
      foilType: data.foilType || null,
      artworkCode: data.artworkCode || null,
      backPrint: data.backPrint || 'No',
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'cartons',
    recordId: carton.id,
    newValue: { cartonName: carton.cartonName },
  })

  return NextResponse.json(carton, { status: 201 })
}

