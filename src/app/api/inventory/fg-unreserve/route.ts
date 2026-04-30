import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const schema = z.object({
  materialId: z.string().uuid(),
  qty: z.number().positive(),
  reservationKey: z.string().min(8).max(120),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse({
    ...body,
    qty: body.qty != null ? Number(body.qty) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
  }
  const { materialId, qty, reservationKey } = parsed.data

  const result = await db.$transaction(async (tx) => {
    const inv = await tx.inventory.findUnique({
      where: { id: materialId },
      select: { id: true, qtyReserved: true, qtyFg: true, unit: true, materialCode: true },
    })
    if (!inv) return { error: 'Material not found', status: 404 as const }
    const reserved = Number(inv.qtyReserved)
    if (qty > reserved) {
      return { error: `Cannot unreserve ${qty}; only ${reserved} reserved`, status: 400 as const }
    }

    await tx.inventory.update({
      where: { id: materialId },
      data: {
        qtyReserved: { decrement: qty },
        qtyFg: { increment: qty },
      },
    })
    const mv = await tx.stockMovement.create({
      data: {
        materialId,
        movementType: 'reserve',
        qty: -qty,
        refType: 'po_draft_fg_unreserve',
        refId: reservationKey,
        userId: user?.id ?? null,
      },
      select: { id: true, createdAt: true },
    })
    return {
      ok: true as const,
      status: 200 as const,
      movementId: mv.id,
      unreservedAt: mv.createdAt.toISOString(),
      materialCode: inv.materialCode,
      unit: inv.unit,
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
      unreserve: true,
      reservationKey,
      materialId,
      qty,
      source: 'po_new_fg_unreserve',
    },
  })

  return NextResponse.json(result)
}
