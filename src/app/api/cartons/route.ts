import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

function cartonSize(c: {
  finishedLength?: unknown
  finishedWidth?: unknown
  finishedHeight?: unknown
}): string {
  const l = c.finishedLength != null ? Number(c.finishedLength) : null
  const w = c.finishedWidth != null ? Number(c.finishedWidth) : null
  const h = c.finishedHeight != null ? Number(c.finishedHeight) : null
  if (l != null && w != null && h != null) return `${l}×${w}×${h}`
  if (l != null && w != null) return `${l}×${w}`
  return ''
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const customerId = searchParams.get('customerId')
  const q = (searchParams.get('q') ?? '').trim().toLowerCase()
  const limitRaw = parseInt(searchParams.get('limit') ?? '4000', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 8000) : 4000

  const list = await db.$queryRawUnsafe<Array<{
    id: string
    cartonName: string
    customerId: string
    customerName: string
    productType: string | null
    cartonSizeText: string | null
    boardGrade: string | null
    gsm: number | null
    paperType: string | null
    rate: number | null
    gstPct: number | null
    coatingType: string | null
    embossingLeafing: string | null
    foilType: string | null
    artworkCode: string | null
    backPrint: string | null
    finishedLength: number | null
    finishedWidth: number | null
    finishedHeight: number | null
    cartonConstruct: string | null
    drugSchedule: string | null
    regulatoryText: string | null
    specialInstructions: string | null
    dyeId: string | null
  }>>(
    `
      select
        c.id,
        c.carton_name as "cartonName",
        c.customer_id as "customerId",
        cu.name as "customerName",
        c.product_type as "productType",
        c.carton_size as "cartonSizeText",
        c.board_grade as "boardGrade",
        c.gsm,
        c.paper_type as "paperType",
        c.rate::float8 as rate,
        c.gst_pct as "gstPct",
        c.coating_type as "coatingType",
        c.embossing_leafing as "embossingLeafing",
        c.foil_type as "foilType",
        c.artwork_code as "artworkCode",
        c.back_print as "backPrint",
        c.finished_length::float8 as "finishedLength",
        c.finished_width::float8 as "finishedWidth",
        c.finished_height::float8 as "finishedHeight",
        c.carton_construct as "cartonConstruct",
        c.drug_schedule as "drugSchedule",
        c.regulatory_text as "regulatoryText",
        c.special_instructions as "specialInstructions",
        c.dye_id as "dyeId"
      from cartons c
      join customers cu on cu.id = c.customer_id
      where c.active = true
        ${customerId ? 'and c.customer_id = $1' : ''}
      order by c.carton_name asc
      limit ${customerId ? '$2' : '$1'}
    `,
    ...(customerId ? [customerId, limit] : [limit]),
  )

  let mapped = list.map((c) => ({
    id: c.id,
    cartonName: c.cartonName,
    customerId: c.customerId,
    customer: { id: c.customerId, name: c.customerName },
    productType: c.productType,
    cartonSize: c.cartonSizeText || cartonSize(c),
    boardGrade: c.boardGrade,
    gsm: c.gsm,
    paperType: c.paperType,
    rate: c.rate != null ? Number(c.rate) : null,
    gstPct: c.gstPct ?? 5,
    coatingType: c.coatingType,
    embossingLeafing: c.embossingLeafing,
    foilType: c.foilType,
    artworkCode: c.artworkCode,
    backPrint: c.backPrint,
    finishedLength: c.finishedLength != null ? Number(c.finishedLength) : null,
    finishedWidth: c.finishedWidth != null ? Number(c.finishedWidth) : null,
    finishedHeight: c.finishedHeight != null ? Number(c.finishedHeight) : null,
    cartonConstruct: c.cartonConstruct,
    drugSchedule: c.drugSchedule,
    regulatoryText: c.regulatoryText,
    specialInstructions: c.specialInstructions,
    dyeId: c.dyeId,
  }))

  if (q) {
    mapped = mapped.filter(
      (c) =>
        c.cartonName.toLowerCase().includes(q) ||
        (c.artworkCode ?? '').toLowerCase().includes(q),
    )
  }

  return NextResponse.json(mapped)
}
