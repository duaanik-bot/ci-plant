import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { computeVariance } from '@/lib/carton/variance'

export const dynamic = 'force-dynamic'

const n = (v: unknown) => (v != null ? Number(v as number) : null)

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { error } = await requireAuth()
  if (error) return error

  const c = await db.carton.findUnique({
    where: { id: params.id },
    include: {
      customer: { select: { id: true, name: true } },
      dieMaster: { select: { id: true, dyeNumber: true, dyeType: true } },
      shadeCard: { select: { id: true, shadeCode: true } },
    },
  })
  if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const spec = {
    l: n(c.finishedLength),
    w: n(c.finishedWidth),
    h: n(c.finishedHeight),
  }
  const physical = { l: n(c.physicalL), w: n(c.physicalW), h: n(c.physicalH) }
  const v = computeVariance(spec, physical, 2)

  return NextResponse.json({
    carton_name: c.cartonName,
    client_name: c.customer.name,
    artwork_code: c.artworkCode,
    dimensions: { spec, physical, variance: v.variance },
    board_grade: c.boardGrade,
    gsm: c.gsm,
    printing_type: c.printingType,
    coating_spec: c.coatingType,
    colours: c.numberOfColours,
    sheet_size: { l: n(c.sheetSizeL), w: n(c.sheetSizeW) },
    ups: c.ups,
    pasting_style: c.pastingStyle,
    rate: n(c.rate),
    gst_percent: c.gstPct,
    hsn_code: c.hsnCode,
    tooling: c.dieMaster
      ? {
          die_master_id: c.dieMaster.id,
          die_master_name: String(c.dieMaster.dyeNumber),
          type: c.dieMaster.dyeType,
        }
      : { die_master_id: null, die_master_name: null, type: null },
    shade_card: c.shadeCard
      ? {
          id: c.shadeCard.id,
          name: c.shadeCard.shadeCode,
          ink_kitchen_status: null,
        }
      : { id: null, name: null, ink_kitchen_status: null },
    special_instructions: c.specialInstructions,
    remarks: c.remarks,
    size_verified: c.sizeVerified,
    last_verified_at: c.sizeVerifiedAt,
  })
}
