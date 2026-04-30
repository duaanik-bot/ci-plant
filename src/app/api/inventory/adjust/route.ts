import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const schema = z.object({
  materialId: z.string().uuid(),
  qty: z.number().positive(),
  direction: z.enum(['add', 'subtract']),
  bucket: z.enum(['quarantine', 'available', 'reserved', 'fg']),
  reasonCode: z.string().min(2).max(64),
  remarks: z.string().min(3).max(500),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse({
    ...body,
    qty: body.qty != null ? Number(body.qty) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const { materialId, qty, direction, bucket, reasonCode, remarks } = parsed.data
  const sign = direction === 'add' ? 1 : -1
  const signedQty = sign * qty

  const inv = await db.inventory.findUnique({ where: { id: materialId } })
  if (!inv) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const current =
    bucket === 'quarantine'
      ? Number(inv.qtyQuarantine)
      : bucket === 'available'
        ? Number(inv.qtyAvailable)
        : bucket === 'reserved'
          ? Number(inv.qtyReserved)
          : Number(inv.qtyFg)
  if (direction === 'subtract' && qty > current) {
    return NextResponse.json(
      { error: `Cannot subtract ${qty}. Current ${bucket}: ${current.toLocaleString('en-IN')}` },
      { status: 400 },
    )
  }

  const data =
    bucket === 'quarantine'
      ? { qtyQuarantine: { increment: signedQty } }
      : bucket === 'available'
        ? { qtyAvailable: { increment: signedQty } }
        : bucket === 'reserved'
          ? { qtyReserved: { increment: signedQty } }
          : { qtyFg: { increment: signedQty } }

  const result = await db.$transaction(async (tx) => {
    await tx.inventory.update({
      where: { id: materialId },
      data,
    })
    const mv = await tx.stockMovement.create({
      data: {
        materialId,
        movementType: 'adjust',
        qty: signedQty,
        refType: `manual_adjust_${bucket}`,
        refId: reasonCode,
        userId: user!.id,
      },
      select: { id: true, createdAt: true },
    })
    return mv
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'inventory',
    recordId: materialId,
    newValue: {
      manualAdjust: true,
      qty: signedQty,
      bucket,
      reasonCode,
      remarks,
      movementId: result.id,
    },
  })

  return NextResponse.json({ ok: true, movementId: result.id, at: result.createdAt.toISOString() })
}
