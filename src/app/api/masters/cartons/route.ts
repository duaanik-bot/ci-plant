import { NextRequest, NextResponse } from 'next/server'
import { PastingStyle } from '@prisma/client'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'
import { cartonSchema } from '@/lib/validations'
import { coercePastingStyleInput, mapLegacyPastingToEnum } from '@/lib/pasting-style'

export const dynamic = 'force-dynamic'

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const createSchema = cartonSchema.extend({
  productType: z.string().optional(),
  category: z.string().optional(),
  rate: z.number().min(0).optional(),
  gstPct: z.number().int().min(0).max(28).default(5),
  active: z.boolean().default(true),
  remarks: z.string().optional(),
  cartonSize: z.string().optional(),
  printSize: z.string().optional(),
  boardGrade: z.string().optional(),
  gsm: z.number().int().min(150).max(600).optional(),
  caliperMicrons: z.number().int().optional(),
  paperType: z.string().optional(),
  plyCount: z.number().int().min(1).max(3).optional(),
  finishedLength: z.number().positive().optional(),
  finishedWidth: z.number().positive().optional(),
  finishedHeight: z.number().positive().optional(),
  blankLength: z.number().positive().optional(),
  blankWidth: z.number().positive().optional(),
  printingType: z.string().optional(),
  numberOfColours: z.number().int().min(1).max(12).optional(),
  coatingType: z.string().optional(),
  embossingLeafing: z.string().optional(),
  foilType: z.string().optional(),
  artworkCode: z.string().optional(),
  backPrint: z.string().optional(),
  pastingStyle: z.nativeEnum(PastingStyle).optional().nullable(),
  pastingType: z.string().optional(),
  glueType: z.string().optional(),
  cartonConstruct: z.string().optional(),
  dyeId: z.string().uuid().optional().nullable(),
  dieMasterId: z.string().uuid().optional().nullable(),
  shadeCardId: z.string().uuid().optional().nullable(),
  dyeCondition: z.string().optional(),
  drugSchedule: z.string().optional(),
  regulatoryText: z.string().optional(),
  specialInstructions: z.string().optional(),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.$queryRawUnsafe<Array<{
    id: string
    cartonName: string
    customerId: string
    customerName: string
    gsm: number | null
    boardGrade: string | null
    paperType: string | null
    coatingType: string | null
    finishedLength: number | null
    finishedWidth: number | null
    finishedHeight: number | null
    rate: number | null
    active: boolean
  }>>(`
    select
      c.id,
      c.carton_name as "cartonName",
      c.customer_id as "customerId",
      cu.name as "customerName",
      c.gsm,
      c.board_grade as "boardGrade",
      c.paper_type as "paperType",
      c.coating_type as "coatingType",
      c.finished_length::float8 as "finishedLength",
      c.finished_width::float8 as "finishedWidth",
      c.finished_height::float8 as "finishedHeight",
      c.rate::float8 as rate,
      c.active
    from cartons c
    join customers cu on cu.id = c.customer_id
    order by c.carton_name asc
  `)
  return NextResponse.json(
    list.map((c) => ({
      id: c.id,
      cartonName: c.cartonName,
      customerId: c.customerId,
      customer: { id: c.customerId, name: c.customerName },
      gsm: c.gsm,
      boardGrade: c.boardGrade,
      paperType: c.paperType,
      coatingType: c.coatingType,
      finishedLength: c.finishedLength,
      finishedWidth: c.finishedWidth,
      finishedHeight: c.finishedHeight,
      rate: c.rate,
      active: c.active,
    }))
  )
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    rate: toOptionalNumber(body.rate),
    gstPct: toOptionalNumber(body.gstPct) ?? 5,
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

  const data = parsed.data

  let resolvedPasting: PastingStyle | null = null
  if (data.pastingStyle !== undefined) {
    resolvedPasting = data.pastingStyle
  } else {
    resolvedPasting =
      coercePastingStyleInput(data.pastingType) ??
      coercePastingStyleInput(data.cartonConstruct) ??
      mapLegacyPastingToEnum(data.pastingType ?? data.cartonConstruct) ??
      null
  }

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
      blankLength: data.blankLength ?? null,
      blankWidth: data.blankWidth ?? null,
      coatingType: data.coatingType || null,
      embossingLeafing: data.embossingLeafing || null,
      foilType: data.foilType || null,
      artworkCode: data.artworkCode || null,
      backPrint: data.backPrint || 'No',
      glueType: data.glueType || null,
      pastingStyle: resolvedPasting,
      dyeId: data.dyeId || null,
      dieMasterId: data.dieMasterId || null,
      shadeCardId: data.shadeCardId || null,
      drugSchedule: data.drugSchedule || null,
      regulatoryText: data.regulatoryText || null,
      remarks: data.remarks?.trim() ? data.remarks.trim() : null,
      printingType: data.printingType?.trim() ? data.printingType.trim() : null,
      numberOfColours: data.numberOfColours ?? null,
      specialInstructions: data.specialInstructions || null,
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
