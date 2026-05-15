import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { recalculateMaterialShortage } from '@/lib/reservation-release'

export const dynamic = 'force-dynamic'

const Body = z.object({ reason: z.string().min(3).max(120) })

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: reservationId } = await context.params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = Body.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const result = await db.$transaction(async (tx) => {
    const existing = await tx.materialReservation.findUnique({
      where: { id: reservationId },
      select: { id: true, isReleased: true, materialId: true },
    })
    if (!existing) return { error: 'not_found' as const }
    if (existing.isReleased) return { error: 'already_released' as const }

    const updated = await tx.materialReservation.update({
      where: { id: reservationId },
      data: {
        isReleased: true,
        releasedAt: new Date(),
        releasedReason: parsed.data.reason,
      },
    })

    const recalc = await recalculateMaterialShortage(existing.materialId, tx)
    return { updated, shortage: recalc.shortage }
  })

  if ('error' in result) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === 'not_found' ? 404 : 409 },
    )
  }

  return NextResponse.json({
    ok: true,
    reservationId: result.updated.id,
    shortage: result.shortage,
  })
}
