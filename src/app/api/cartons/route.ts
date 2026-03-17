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

  const list = await db.carton.findMany({
    where: {
      active: true,
      ...(customerId ? { customerId } : {}),
    },
    include: { customer: { select: { id: true, name: true } } },
    orderBy: { cartonName: 'asc' },
  })

  let mapped = list.map((c) => ({
    id: c.id,
    cartonName: c.cartonName,
    customerId: c.customerId,
    customer: c.customer,
    cartonSize: cartonSize(c),
    boardGrade: c.boardGrade,
    gsm: c.gsm,
    paperType: c.paperType,
    rate: c.rate != null ? Number(c.rate) : null,
    gstPct: c.gstPct,
    coatingType: c.coatingType,
    embossingLeafing: c.embossingLeafing,
    foilType: c.foilType,
    artworkCode: c.artworkCode,
    backPrint: c.backPrint,
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
