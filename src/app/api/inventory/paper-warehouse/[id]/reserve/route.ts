import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, createAuditLog } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  qtySheets: z.number().positive(),
  reason: z.string().max(200).optional(),
})

/**
 * Manual reservation: block N sheets of a material with no job attached.
 * Mirrors the fg-reserve accounting — increments the imperative
 * Inventory.qtyReserved counter (free stock = qtyAvailable - qtyReserved),
 * records a MaterialReservation with a null jobCardId, and logs a stock
 * movement. Released via /api/inventory/reservations/[id]/release.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole(
    'stores',
    'production_manager',
    'operations_head',
    'md',
  )
  if (error) return error

  const { id: materialId } = await context.params

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.flatten() }, { status: 400 })
  }
  const { qtySheets, reason } = parsed.data

  const result = await db.$transaction(async (tx) => {
    const inv = await tx.inventory.findUnique({
      where: { id: materialId },
      select: { id: true, materialCode: true, qtyAvailable: true, qtyReserved: true },
    })
    if (!inv) return { error: 'Material not found', status: 404 as const }

    const available = Math.max(0, Number(inv.qtyAvailable))
    const reserved = Math.max(0, Number(inv.qtyReserved))
    const free = available - reserved
    if (qtySheets > free) {
      return {
        error: `Cannot reserve ${qtySheets.toLocaleString('en-IN')} sheets — only ${free.toLocaleString('en-IN')} free`,
        status: 400 as const,
      }
    }

    await tx.inventory.update({
      where: { id: materialId },
      data: { qtyReserved: { increment: qtySheets } },
    })

    const reservation = await tx.materialReservation.create({
      data: {
        materialId,
        jobCardId: null,
        requiredSheets: qtySheets,
        reservedSheets: qtySheets,
        shortageSheets: 0,
        status: 'confirmed',
        isReleased: false,
      },
      select: { id: true },
    })

    const mv = await tx.stockMovement.create({
      data: {
        materialId,
        movementType: 'reserve',
        qty: qtySheets,
        refType: 'manual_reserve',
        refId: reservation.id,
        userId: user?.id ?? null,
      },
      select: { id: true },
    })

    return { status: 200 as const, reservationId: reservation.id, movementId: mv.id, materialCode: inv.materialCode }
  })

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  await createAuditLog({
    userId: user?.id ?? null,
    action: 'INSERT',
    tableName: 'material_reservations',
    recordId: result.reservationId,
    oldValue: null,
    newValue: { materialId, qtySheets, manual: true, reason: reason ?? null },
  })

  return NextResponse.json({ ok: true, reservationId: result.reservationId })
}
