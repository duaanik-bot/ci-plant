import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { checkPlateAvailability } from '@/lib/plate-engine'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const cartonId = searchParams.get('cartonId') ?? ''
  const artworkCode = searchParams.get('artworkCode') ?? ''
  const artworkVersion = searchParams.get('artworkVersion') ?? ''

  if (!artworkCode || !artworkVersion) {
    return NextResponse.json(
      { error: 'cartonId, artworkCode and artworkVersion are required' },
      { status: 400 },
    )
  }

  const carton = cartonId
    ? await db.carton.findUnique({ where: { id: cartonId } })
    : await db.carton.findFirst({ where: { artworkCode } })

  const colourBreakdownRaw = Array.isArray(carton?.colourBreakdown)
    ? (carton?.colourBreakdown as unknown[])
    : []
  const colourBreakdown = colourBreakdownRaw
    .map((c) => (c && typeof c === 'object' && 'name' in c ? String((c as { name: unknown }).name) : ''))
    .filter(Boolean)
    .map((name) => ({ name }))

  const result = await checkPlateAvailability(
    carton?.id ?? cartonId,
    artworkCode,
    artworkVersion,
    carton?.numberOfColours ?? Math.max(colourBreakdown.length, 4),
    colourBreakdown.length ? colourBreakdown : [{ name: 'C' }, { name: 'M' }, { name: 'Y' }, { name: 'K' }],
  )

  return NextResponse.json(result)
}
