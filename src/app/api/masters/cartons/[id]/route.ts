import { NextRequest, NextResponse } from 'next/server'
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

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const rows = await db.$queryRawUnsafe<Array<{
    id: string
    cartonName: string
    customerId: string
    productType: string | null
    category: string | null
    rate: number | null
    gstPct: number
    active: boolean
    remarks: string | null
    cartonSize: string | null
    printSize: string | null
    dyeCondition: string | null
    boardGrade: string | null
    gsm: number | null
    caliperMicrons: number | null
    paperType: string | null
    plyCount: number | null
    finishedLength: number | null
    finishedWidth: number | null
    finishedHeight: number | null
    blankLength: number | null
    blankWidth: number | null
    backPrint: string
    printingType: string | null
    artworkCode: string | null
    coatingType: string | null
    foilType: string | null
    embossingLeafing: string | null
    dyeId: string | null
    cartonConstruct: string | null
    pastingType: string | null
    glueType: string | null
    drugSchedule: string | null
    regulatoryText: string | null
    specialInstructions: string | null
    customerName: string
    dyeNumber: number | null
    dyeSheetSize: string | null
    dyeConditionRating: string | null
    dyeConditionValue: string | null
  }>>(`
    select
      c.id,
      c.carton_name as "cartonName",
      c.customer_id as "customerId",
      c.product_type as "productType",
      c.category,
      c.rate::float8 as rate,
      c.gst_pct as "gstPct",
      c.active,
      c.remarks,
      c.carton_size as "cartonSize",
      c.print_size as "printSize",
      c.dye_condition as "dyeCondition",
      c.board_grade as "boardGrade",
      c.gsm,
      c.caliper_microns as "caliperMicrons",
      c.paper_type as "paperType",
      c.ply_count as "plyCount",
      c.finished_length::float8 as "finishedLength",
      c.finished_width::float8 as "finishedWidth",
      c.finished_height::float8 as "finishedHeight",
      c.blank_length::float8 as "blankLength",
      c.blank_width::float8 as "blankWidth",
      c.back_print as "backPrint",
      c.printing_type as "printingType",
      c.artwork_code as "artworkCode",
      c.coating_type as "coatingType",
      c.foil_type as "foilType",
      c.embossing_leafing as "embossingLeafing",
      c.dye_id as "dyeId",
      c.carton_construct as "cartonConstruct",
      c.pasting_type as "pastingType",
      c.glue_type as "glueType",
      c.drug_schedule as "drugSchedule",
      c.regulatory_text as "regulatoryText",
      c.special_instructions as "specialInstructions",
      cu.name as "customerName",
      d.dye_number as "dyeNumber",
      d.sheet_size as "dyeSheetSize",
      d.condition_rating as "dyeConditionRating",
      d.condition as "dyeConditionValue"
    from cartons c
    join customers cu on cu.id = c.customer_id
    left join dyes d on d.id = c.dye_id
    where c.id = $1
    limit 1
  `, id)
  const carton = rows[0]
  if (!carton) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    ...carton,
    customer: { id: carton.customerId, name: carton.customerName },
    dye: carton.dyeId
      ? {
          id: carton.dyeId,
          dyeNumber: carton.dyeNumber,
          sheetSize: carton.dyeSheetSize,
          condition: carton.dyeConditionValue,
          conditionRating: carton.dyeConditionRating,
        }
      : null,
  })
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

  const existingRows = await db.$queryRawUnsafe<Array<{
    id: string
    cartonName: string
    customerId: string
  }>>(
    `
      select id, carton_name as "cartonName", customer_id as "customerId"
      from cartons
      where id = $1
      limit 1
    `,
    id,
  )
  const existing = existingRows[0]
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data = parsed.data
  const assignments: string[] = []
  const values: unknown[] = []
  const set = (column: string, value: unknown) => {
    values.push(value)
    assignments.push(`${column} = $${values.length}`)
  }

  if (data.cartonName !== undefined) set('carton_name', data.cartonName)
  if (data.customerId !== undefined) set('customer_id', data.customerId)
  if (data.productType !== undefined) set('product_type', toNullableText(data.productType))
  if (data.category !== undefined) set('category', toNullableText(data.category))
  if (data.rate !== undefined) set('rate', data.rate)
  if (data.gstPct !== undefined) set('gst_pct', data.gstPct)
  if (data.active !== undefined) set('active', data.active)
  if (data.remarks !== undefined) set('remarks', toNullableText(data.remarks))
  if (data.cartonSize !== undefined) set('carton_size', toNullableText(data.cartonSize))
  if (data.printSize !== undefined) set('print_size', toNullableText(data.printSize))
  if (data.boardGrade !== undefined) set('board_grade', toNullableText(data.boardGrade))
  if (data.gsm !== undefined) set('gsm', data.gsm)
  if (data.caliperMicrons !== undefined) set('caliper_microns', data.caliperMicrons)
  if (data.paperType !== undefined) set('paper_type', toNullableText(data.paperType))
  if (data.plyCount !== undefined) set('ply_count', data.plyCount)
  if (data.printingType !== undefined) set('printing_type', toNullableText(data.printingType))
  if (data.coatingType !== undefined) set('coating_type', toNullableText(data.coatingType))
  if (data.embossingLeafing !== undefined) set('embossing_leafing', toNullableText(data.embossingLeafing))
  if (data.artworkCode !== undefined) set('artwork_code', toNullableText(data.artworkCode))
  if (data.pastingType !== undefined) set('pasting_type', toNullableText(data.pastingType))
  if (data.glueType !== undefined) set('glue_type', toNullableText(data.glueType))
  if (data.cartonConstruct !== undefined) set('carton_construct', toNullableText(data.cartonConstruct))
  if (data.dyeId !== undefined) set('dye_id', data.dyeId || null)
  if (data.dyeCondition !== undefined) set('dye_condition', toNullableText(data.dyeCondition))
  if (data.finishedLength !== undefined) set('finished_length', data.finishedLength)
  if (data.finishedWidth !== undefined) set('finished_width', data.finishedWidth)
  if (data.finishedHeight !== undefined) set('finished_height', data.finishedHeight)
  if (data.blankLength !== undefined) set('blank_length', data.blankLength)
  if (data.blankWidth !== undefined) set('blank_width', data.blankWidth)
  if (data.drugSchedule !== undefined) set('drug_schedule', toNullableText(data.drugSchedule))
  if (data.regulatoryText !== undefined) set('regulatory_text', toNullableText(data.regulatoryText))
  if (data.specialInstructions !== undefined) set('special_instructions', toNullableText(data.specialInstructions))

  if (assignments.length === 0) {
    return NextResponse.json({ error: 'No changes provided' }, { status: 400 })
  }

  values.push(id)
  await db.$executeRawUnsafe(
    `
      update cartons
      set ${assignments.join(', ')}, updated_at = now()
      where id = $${values.length}
    `,
    ...values,
  )

  const updatedRows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `
      select
        id,
        carton_name as "cartonName",
        customer_id as "customerId",
        product_type as "productType",
        category,
        rate::float8 as rate,
        gst_pct as "gstPct",
        active,
        remarks,
        carton_size as "cartonSize",
        print_size as "printSize",
        board_grade as "boardGrade",
        gsm,
        caliper_microns as "caliperMicrons",
        paper_type as "paperType",
        ply_count as "plyCount",
        printing_type as "printingType",
        coating_type as "coatingType",
        embossing_leafing as "embossingLeafing",
        artwork_code as "artworkCode",
        foil_type as "foilType",
        pasting_type as "pastingType",
        glue_type as "glueType",
        carton_construct as "cartonConstruct",
        dye_id as "dyeId",
        dye_condition as "dyeCondition",
        finished_length::float8 as "finishedLength",
        finished_width::float8 as "finishedWidth",
        finished_height::float8 as "finishedHeight",
        blank_length::float8 as "blankLength",
        blank_width::float8 as "blankWidth",
        drug_schedule as "drugSchedule",
        regulatory_text as "regulatoryText",
        special_instructions as "specialInstructions"
      from cartons
      where id = $1
      limit 1
    `,
    id,
  )
  const updated = updatedRows[0]

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'cartons',
    recordId: id,
    newValue: parsed.data,
  })

  return NextResponse.json(updated)
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const existingRows = await db.$queryRawUnsafe<Array<{
    id: string
    cartonName: string
    customerId: string
  }>>(
    `
      select id, carton_name as "cartonName", customer_id as "customerId"
      from cartons
      where id = $1
      limit 1
    `,
    id,
  )
  const existing = existingRows[0]
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await db.$executeRawUnsafe('delete from cartons where id = $1', id)

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'cartons',
    recordId: id,
    oldValue: { cartonName: existing.cartonName, customerId: existing.customerId },
  })

  return NextResponse.json({ ok: true })
}
