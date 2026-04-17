import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'
import { cartonSchema } from '@/lib/validations'

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

function num(d: unknown): number | null {
  if (d == null) return null
  const n = Number(d)
  return Number.isFinite(n) ? n : null
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

const cartonInclude = {
  customer: true,
  dye: {
    select: {
      id: true,
      dyeNumber: true,
      sheetSize: true,
      condition: true,
      conditionRating: true,
    },
  },
} as const

function serializeCarton(
  row: Prisma.CartonGetPayload<{ include: typeof cartonInclude }>,
) {
  const construct = row.cartonConstruct?.trim() || ''
  return {
    id: row.id,
    cartonName: row.cartonName,
    customerId: row.customerId,
    productType: row.productType,
    category: row.category,
    rate: num(row.rate),
    gstPct: row.gstPct,
    active: row.active,
    boardGrade: row.boardGrade,
    gsm: row.gsm,
    caliperMicrons: row.caliperMicrons,
    paperType: row.paperType,
    plyCount: row.plyCount,
    finishedLength: num(row.finishedLength),
    finishedWidth: num(row.finishedWidth),
    finishedHeight: num(row.finishedHeight),
    blankLength: num(row.blankLength),
    blankWidth: num(row.blankWidth),
    backPrint: row.backPrint,
    artworkCode: row.artworkCode,
    coatingType: row.coatingType,
    foilType: row.foilType,
    embossingLeafing: row.embossingLeafing,
    dyeId: row.dyeId,
    cartonConstruct: row.cartonConstruct,
    glueType: row.glueType,
    drugSchedule: row.drugSchedule,
    regulatoryText: row.regulatoryText,
    specialInstructions: row.specialInstructions,
    plateSize: row.plateSize,
    /** UI field — stored as `carton_construct` in DB. */
    pastingType: construct,
    /** No dedicated column; form value is not persisted until schema adds it. */
    printingType: '',
    /** No dedicated column; form value is not persisted until schema adds it. */
    remarks: '',
    customer: { id: row.customer.id, name: row.customer.name },
    dye: row.dye
      ? {
          id: row.dye.id,
          dyeNumber: row.dye.dyeNumber,
          sheetSize: row.dye.sheetSize,
          condition: row.dye.condition,
          conditionRating: row.dye.conditionRating,
        }
      : null,
  }
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { error } = await requireRole('operations_head', 'md')
    if (error) return error

    const { id } = await context.params
    const row = await db.carton.findUnique({
      where: { id },
      include: cartonInclude,
    })
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json(serializeCarton(row))
  } catch (e) {
    console.error('[cartons/[id] GET]', e)
    return NextResponse.json({ error: 'Failed to load carton' }, { status: 500 })
  }
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
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
    const u: Prisma.CartonUpdateInput = {}

    if (data.cartonName !== undefined) u.cartonName = data.cartonName.trim()
    if (data.customerId !== undefined) u.customer = { connect: { id: data.customerId } }
    if (data.productType !== undefined) u.productType = toNullableText(data.productType) ?? null
    if (data.category !== undefined) u.category = toNullableText(data.category) ?? null
    if (data.rate !== undefined) u.rate = data.rate
    if (data.gstPct !== undefined) u.gstPct = data.gstPct
    if (data.active !== undefined) u.active = data.active
    if (data.boardGrade !== undefined) u.boardGrade = toNullableText(data.boardGrade) ?? null
    if (data.gsm !== undefined) u.gsm = data.gsm
    if (data.caliperMicrons !== undefined) u.caliperMicrons = data.caliperMicrons
    if (data.paperType !== undefined) u.paperType = toNullableText(data.paperType) ?? null
    if (data.plyCount !== undefined) u.plyCount = data.plyCount
    if (data.coatingType !== undefined) u.coatingType = toNullableText(data.coatingType) ?? null
    if (data.embossingLeafing !== undefined) {
      u.embossingLeafing = toNullableText(data.embossingLeafing) ?? null
    }
    if (data.artworkCode !== undefined) u.artworkCode = toNullableText(data.artworkCode) ?? null
    if (data.glueType !== undefined) u.glueType = toNullableText(data.glueType) ?? null
    if (data.cartonConstruct !== undefined) {
      u.cartonConstruct = toNullableText(data.cartonConstruct) ?? null
    }
    /** Form field `pastingType` maps to `carton_construct`. */
    if (data.pastingType !== undefined) {
      u.cartonConstruct = toNullableText(data.pastingType) ?? null
    }
    if (data.dyeId !== undefined) {
      u.dye = data.dyeId ? { connect: { id: data.dyeId } } : { disconnect: true }
    }
    if (data.finishedLength !== undefined) u.finishedLength = data.finishedLength
    if (data.finishedWidth !== undefined) u.finishedWidth = data.finishedWidth
    if (data.finishedHeight !== undefined) u.finishedHeight = data.finishedHeight
    if (data.blankLength !== undefined) u.blankLength = data.blankLength
    if (data.blankWidth !== undefined) u.blankWidth = data.blankWidth
    if (data.drugSchedule !== undefined) u.drugSchedule = toNullableText(data.drugSchedule) ?? null
    if (data.regulatoryText !== undefined) {
      u.regulatoryText = toNullableText(data.regulatoryText) ?? null
    }
    if (data.specialInstructions !== undefined) {
      u.specialInstructions = toNullableText(data.specialInstructions) ?? null
    }

    if (Object.keys(u).length === 0) {
      return NextResponse.json({ error: 'No changes provided' }, { status: 400 })
    }

    await db.carton.update({
      where: { id },
      data: u,
    })

    const refreshed = await db.carton.findUnique({
      where: { id },
      include: cartonInclude,
    })
    if (!refreshed) {
      return NextResponse.json({ error: 'Not found after update' }, { status: 404 })
    }

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'cartons',
      recordId: id,
      newValue: parsed.data as Record<string, unknown>,
    })

    return NextResponse.json(serializeCarton(refreshed))
  } catch (e) {
    console.error('[cartons/[id] PUT]', e)
    return NextResponse.json({ error: 'Failed to update carton' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
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
  } catch (e) {
    console.error('[cartons/[id] DELETE]', e)
    return NextResponse.json({ error: 'Failed to delete carton' }, { status: 500 })
  }
}
