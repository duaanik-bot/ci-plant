import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const reserveSchema = z.object({
  materialId: z.string().uuid(),
  qty: z.number().positive(),
  reservationKey: z.string().min(8).max(120),
  cartonName: z.string().optional(),
  artworkCode: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = reserveSchema.safeParse({
    ...body,
    qty: body.qty != null ? Number(body.qty) : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const k = i.path.join('.')
      if (k && !fields[k]) fields[k] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const { materialId, qty, reservationKey, cartonName, artworkCode } = parsed.data

  const result = await db.$transaction(async (tx) => {
    const inv = await tx.inventory.findUnique({
      where: { id: materialId },
      select: {
        id: true,
        materialCode: true,
        description: true,
        unit: true,
        qtyFg: true,
        qtyReserved: true,
      },
    })
    if (!inv) return { error: 'FG material not found', status: 404 as const }
    const onHandFg = Number(inv.qtyFg)
    if (qty > onHandFg) {
      return {
        error: `Insufficient FG stock. Available: ${onHandFg.toLocaleString('en-IN')} ${inv.unit}`,
        status: 400 as const,
      }
    }

    await tx.inventory.update({
      where: { id: materialId },
      data: {
        qtyFg: { decrement: qty },
        qtyReserved: { increment: qty },
      },
    })

    const mv = await tx.stockMovement.create({
      data: {
        materialId,
        movementType: 'reserve',
        qty,
        refType: 'po_draft_fg_reserve',
        refId: reservationKey,
        userId: user?.id ?? null,
      },
      select: { id: true, createdAt: true },
    })

    return {
      status: 200 as const,
      ok: true as const,
      materialCode: inv.materialCode,
      description: inv.description,
      qtyReserved: qty,
      unit: inv.unit,
      movementId: mv.id,
      reservedAt: mv.createdAt.toISOString(),
      qtyFgAfter: onHandFg - qty,
    }
  })

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  await createAuditLog({
    userId: user?.id ?? null,
    action: 'INSERT',
    tableName: 'stock_movements',
    recordId: result.movementId,
    newValue: {
      movementType: 'reserve',
      reservationKey,
      materialId,
      qty,
      cartonName: cartonName?.trim() || null,
      artworkCode: artworkCode?.trim() || null,
      source: 'po_new_fg_reserve',
    },
  })

  return NextResponse.json(result)
}
