import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const schema = z.object({
  movementId: z.string().uuid(),
  remarks: z.string().min(3).max(500),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
  }

  const mv = await db.stockMovement.findUnique({ where: { id: parsed.data.movementId } })
  if (!mv) return NextResponse.json({ error: 'Movement not found' }, { status: 404 })
  if (mv.movementType !== 'adjust' || !String(mv.refType || '').startsWith('manual_adjust_')) {
    return NextResponse.json({ error: 'Only manual adjust movements can be reversed' }, { status: 400 })
  }

  const already = await db.stockMovement.findFirst({
    where: { refType: 'manual_reverse', refId: mv.id },
    select: { id: true },
  })
  if (already) return NextResponse.json({ error: 'Movement already reversed' }, { status: 400 })

  const bucket = String(mv.refType).replace('manual_adjust_', '')
  if (!['quarantine', 'available', 'reserved', 'fg'].includes(bucket)) {
    return NextResponse.json({ error: 'Unsupported bucket' }, { status: 400 })
  }

  const signedQty = -Number(mv.qty)

  const inv = await db.inventory.findUnique({ where: { id: mv.materialId } })
  if (!inv) return NextResponse.json({ error: 'Material not found' }, { status: 404 })
  const current =
    bucket === 'quarantine'
      ? Number(inv.qtyQuarantine)
      : bucket === 'available'
        ? Number(inv.qtyAvailable)
        : bucket === 'reserved'
          ? Number(inv.qtyReserved)
          : Number(inv.qtyFg)
  if (signedQty < 0 && Math.abs(signedQty) > current) {
    return NextResponse.json({ error: `Cannot reverse: ${bucket} would go negative` }, { status: 400 })
  }

  const data =
    bucket === 'quarantine'
      ? { qtyQuarantine: { increment: signedQty } }
      : bucket === 'available'
        ? { qtyAvailable: { increment: signedQty } }
        : bucket === 'reserved'
          ? { qtyReserved: { increment: signedQty } }
          : { qtyFg: { increment: signedQty } }

  const reverse = await db.$transaction(async (tx) => {
    await tx.inventory.update({ where: { id: mv.materialId }, data })
    return tx.stockMovement.create({
      data: {
        materialId: mv.materialId,
        movementType: 'adjust',
        qty: signedQty,
        refType: 'manual_reverse',
        refId: mv.id,
        userId: user!.id,
      },
      select: { id: true, createdAt: true },
    })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'stock_movements',
    recordId: reverse.id,
    newValue: { reversedMovementId: mv.id, remarks: parsed.data.remarks },
  })

  return NextResponse.json({ ok: true, movementId: reverse.id, at: reverse.createdAt.toISOString() })
}
