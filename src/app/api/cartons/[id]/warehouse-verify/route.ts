import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { computeVariance } from '@/lib/carton/variance'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const physical = {
    l: body.physical_l != null && body.physical_l !== '' ? Number(body.physical_l) : null,
    w: body.physical_w != null && body.physical_w !== '' ? Number(body.physical_w) : null,
    h: body.physical_h != null && body.physical_h !== '' ? Number(body.physical_h) : null,
  }

  const carton = await db.carton.findUnique({ where: { id: params.id } })
  if (!carton)
    return NextResponse.json({ error: 'Carton not found' }, { status: 404 })

  const spec = {
    l: carton.finishedLength != null ? Number(carton.finishedLength) : null,
    w: carton.finishedWidth != null ? Number(carton.finishedWidth) : null,
    h: carton.finishedHeight != null ? Number(carton.finishedHeight) : null,
  }
  const v = computeVariance(spec, physical, 2)

  const updated = await db.carton.update({
    where: { id: params.id },
    data: {
      physicalL: physical.l,
      physicalW: physical.w,
      physicalH: physical.h,
      sizeVerified: true,
      sizeVerifiedAt: new Date(),
      sizeVerifiedBy:
        (body.verified_by as string) ??
        (user?.name as string) ??
        (user?.email as string) ??
        'unknown',
      sizeVarianceNotes: (body.notes as string) ?? null,
    },
  })

  return NextResponse.json({
    carton: updated,
    variance: v.variance,
    maxAbsVariance: v.maxAbsVariance,
    status: v.sizeMismatch ? 'size_mismatch' : 'ok',
  })
}
