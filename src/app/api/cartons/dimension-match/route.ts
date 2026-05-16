import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { dimensionMatch } from '@/lib/carton/match'

export const dynamic = 'force-dynamic'
const n = (v: unknown) => (v != null ? Number(v as number) : null)

export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const target = { l: Number(body.l), w: Number(body.w), h: Number(body.h) }
  const tol = body.tolerance_mm != null ? Number(body.tolerance_mm) : 3

  const rows = await db.carton.findMany({
    where: {
      active: true,
      ...(body.client_id ? { customerId: body.client_id } : {}),
      finishedLength: { not: null },
    },
    include: { customer: { select: { id: true, name: true } } },
    take: 2000,
  })

  const exact_matches: unknown[] = []
  const close_matches: unknown[] = []
  const different_orientation: unknown[] = []

  for (const c of rows) {
    const cand = {
      l: n(c.finishedLength),
      w: n(c.finishedWidth),
      h: n(c.finishedHeight),
    }
    const m = dimensionMatch(target, cand, tol)
    const item = {
      id: c.id,
      carton_name: c.cartonName,
      client_name: c.customer.name,
      dims: cand,
    }
    if (m === 'exact') exact_matches.push(item)
    else if (m === 'rotated') different_orientation.push(item)
    else if (dimensionMatch(target, cand, tol + 3) === 'exact')
      close_matches.push(item)
  }

  return NextResponse.json({
    exact_matches,
    close_matches,
    different_orientation,
  })
}
