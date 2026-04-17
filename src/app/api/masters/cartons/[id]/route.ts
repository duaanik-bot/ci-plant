import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'
import { cartonSchema } from '@/lib/validations'
import { serializeCarton } from '@/lib/carton-serialize'

export const dynamic = 'force-dynamic'

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toNullableText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const trimmed = String(value).trim()
  return trimmed ? trimmed : null
}

const updateSchema = cartonSchema.partial().extend({
  productType: z.string().optional(),
  category: z.string().optional(),
  rate: z.number().min(0).optional(),
  gstPct: z.number().int().min(0).max(28).optional(),
  active: z.boolean().optional(),
  remarks: z.string().optional().nullable(),
  cartonSize: z.string().optional().nullable(),
  printSize: z.string().optional().nullable(),
  boardGrade: z.string().optional(),
  gsm: z.number().int().min(150).max(600).optional(),
  caliperMicrons: z.number().int().optional(),
  paperType: z.string().optional(),
  plyCount: z.number().int().min(1).max(3).optional(),
  printingType: z.string().optional().nullable(),
  coatingType: z.string().optional().nullable(),
  embossingLeafing: z.string().optional().nullable(),
  artworkCode: z.string().optional().nullable(),
  pastingType: z.string().optional().nullable(),
  glueType: z.string().optional().nullable(),
  cartonConstruct: z.string().optional().nullable(),
  dyeId: z.string().uuid().optional().nullable(),
  dieMasterId: z.string().uuid().optional().nullable(),
  dyeCondition: z.string().optional().nullable(),
  finishedLength: z.number().positive().optional().nullable(),
  finishedWidth: z.number().positive().optional().nullable(),
  finishedHeight: z.number().positive().optional().nullable(),
  blankLength: z.number().positive().optional().nullable(),
  blankWidth: z.number().positive().optional().nullable(),
  drugSchedule: z.string().optional().nullable(),
  regulatoryText: z.string().optional().nullable(),
  specialInstructions: z.string().optional().nullable(),
})

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const row = await db.carton.findUnique({
    where: { id },
    include: { customer: true, dye: true, dieMaster: true },
  })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(serializeCarton(row))
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    rate: toOptionalNumber(body.rate),
    gstPct: toOptionalNumber(body.gstPct),
    finishedLength: toOptionalNumber(body.finishedLength),
    finishedWidth: toOptionalNumber(body.finishedWidth),
    finishedHeight: toOptionalNumber(body.finishedHeight),
    blankLength: toOptionalNumber(body.blankLength),
    blankWidth: toOptionalNumber(body.blankWidth),
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.carton.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data = parsed.data
  const update: Prisma.CartonUpdateInput = {}

  if (data.cartonName !== undefined) update.cartonName = data.cartonName.trim()
  if (data.customerId !== undefined) update.customer = { connect: { id: data.customerId } }
  if (data.productType !== undefined) update.productType = toNullableText(data.productType)
  if (data.category !== undefined) update.category = toNullableText(data.category)
  if (data.rate !== undefined) update.rate = data.rate
  if (data.gstPct !== undefined) update.gstPct = data.gstPct
  if (data.active !== undefined) update.active = data.active
  if (data.remarks !== undefined) update.remarks = toNullableText(data.remarks)
  if (data.boardGrade !== undefined) update.boardGrade = toNullableText(data.boardGrade)
  if (data.gsm !== undefined) update.gsm = data.gsm
  if (data.caliperMicrons !== undefined) update.caliperMicrons = data.caliperMicrons
  if (data.paperType !== undefined) update.paperType = toNullableText(data.paperType)
  if (data.plyCount !== undefined) update.plyCount = data.plyCount
  if (data.printingType !== undefined) update.printingType = toNullableText(data.printingType)
  if (data.coatingType !== undefined) update.coatingType = toNullableText(data.coatingType)
  if (data.embossingLeafing !== undefined) update.embossingLeafing = toNullableText(data.embossingLeafing)
  if (data.artworkCode !== undefined) update.artworkCode = toNullableText(data.artworkCode)
  if (data.glueType !== undefined) update.glueType = toNullableText(data.glueType)
  if (data.pastingType !== undefined || data.cartonConstruct !== undefined) {
    const v =
      data.cartonConstruct !== undefined ? data.cartonConstruct : data.pastingType
    update.cartonConstruct = toNullableText(v) ?? null
  }
  if (data.dyeId !== undefined) {
    if (data.dyeId) update.dye = { connect: { id: data.dyeId } }
    else update.dye = { disconnect: true }
  }
  if (data.dieMasterId !== undefined) {
    if (data.dieMasterId) update.dieMaster = { connect: { id: data.dieMasterId } }
    else update.dieMaster = { disconnect: true }
  }
  if (data.finishedLength !== undefined) update.finishedLength = data.finishedLength
  if (data.finishedWidth !== undefined) update.finishedWidth = data.finishedWidth
  if (data.finishedHeight !== undefined) update.finishedHeight = data.finishedHeight
  if (data.blankLength !== undefined) update.blankLength = data.blankLength
  if (data.blankWidth !== undefined) update.blankWidth = data.blankWidth
  if (data.drugSchedule !== undefined) update.drugSchedule = toNullableText(data.drugSchedule)
  if (data.regulatoryText !== undefined) update.regulatoryText = toNullableText(data.regulatoryText)
  if (data.specialInstructions !== undefined) {
    update.specialInstructions = toNullableText(data.specialInstructions)
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No changes provided' }, { status: 400 })
  }

  const row = await db.carton.update({
    where: { id },
    data: update,
    include: { customer: true, dye: true, dieMaster: true },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'cartons',
    recordId: id,
    newValue: parsed.data,
  })

  return NextResponse.json(serializeCarton(row))
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const existing = await db.carton.findUnique({
    where: { id },
    select: { id: true, cartonName: true, customerId: true },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await db.carton.delete({ where: { id } })

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'cartons',
    recordId: id,
    oldValue: { cartonName: existing.cartonName, customerId: existing.customerId },
  })

  return NextResponse.json({ ok: true })
}
