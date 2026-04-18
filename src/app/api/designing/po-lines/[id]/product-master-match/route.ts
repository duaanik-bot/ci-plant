import { NextRequest, NextResponse } from 'next/server'
import type { PlateSize } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

function plateSizeLabel(p: PlateSize | null | undefined): string | null {
  if (!p) return null
  if (p === 'SIZE_560_670') return '560 × 670'
  if (p === 'SIZE_630_700') return '630 × 700'
  return null
}

/** GET — Product master (carton + die master) hints for AW Queue Smart Match. */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params

  const line = await db.poLineItem.findUnique({
    where: { id: lineId },
    select: { cartonId: true },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  if (!line.cartonId) {
    return NextResponse.json({
      awCode: null,
      actualSheetSize: null,
      numberOfUps: null,
      cartonLwh: null,
      revisionDate: null,
      hasProductDie: false,
      hasProductEmboss: false,
    })
  }

  const carton = await db.carton.findUnique({
    where: { id: line.cartonId },
    select: {
      artworkCode: true,
      plateSize: true,
      finishedLength: true,
      finishedWidth: true,
      finishedHeight: true,
      updatedAt: true,
      dieMasterId: true,
      embossBlockId: true,
      dieMaster: {
        select: {
          sheetSize: true,
          ups: true,
        },
      },
    },
  })

  if (!carton) {
    return NextResponse.json({
      awCode: null,
      actualSheetSize: null,
      numberOfUps: null,
      cartonLwh: null,
      revisionDate: null,
      hasProductDie: false,
      hasProductEmboss: false,
    })
  }

  const fmt = (v: unknown) => {
    if (v == null || v === '') return ''
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : String(v)
  }
  const L = fmt(carton.finishedLength)
  const W = fmt(carton.finishedWidth)
  const H = fmt(carton.finishedHeight)
  const cartonLwh = L && W && H ? `${L}×${W}×${H}` : null

  const sheetFromMaster = carton.dieMaster?.sheetSize?.trim() || null
  const sheetFromPlate = plateSizeLabel(carton.plateSize)
  const actualSheetSize = sheetFromMaster || sheetFromPlate

  return NextResponse.json({
    awCode: carton.artworkCode?.trim() || null,
    actualSheetSize,
    numberOfUps: carton.dieMaster?.ups ?? null,
    cartonLwh,
    revisionDate: carton.updatedAt.toISOString(),
    hasProductDie: !!carton.dieMasterId?.trim(),
    hasProductEmboss: !!carton.embossBlockId?.trim(),
  })
}
