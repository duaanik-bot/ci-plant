import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Async search for Plate Hub add-stock modal (carton master + dye UPS). */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  if (q.length < 2) {
    return NextResponse.json([])
  }

  const rows = await db.carton.findMany({
    where: {
      active: true,
      cartonName: { contains: q, mode: 'insensitive' },
    },
    take: 25,
    orderBy: { cartonName: 'asc' },
    select: {
      id: true,
      cartonName: true,
      artworkCode: true,
      customerId: true,
      customer: { select: { id: true, name: true } },
      dye: { select: { ups: true } },
    },
  })

  return NextResponse.json(
    rows.map((c) => ({
      id: c.id,
      cartonName: c.cartonName,
      artworkCode: c.artworkCode?.trim() || null,
      customerId: c.customerId,
      customer: c.customer,
      ups: c.dye?.ups ?? null,
    })),
  )
}
