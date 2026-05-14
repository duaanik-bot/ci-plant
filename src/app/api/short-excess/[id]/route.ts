import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('close'), notes: z.string().optional() }),
  z.object({ action: z.literal('send_to_planning') }),
  z.object({
    action: z.literal('send_to_fg'),
    materialId: z.string().uuid(),
    qty: z.number().positive(),
  }),
])

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { error, user } = await requireAuth()
  if (error) return error

  const record = await db.shortExcessRecord.findUnique({
    where: { id: params.id },
    include: { poLineItem: true },
  })
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', fields: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { action } = parsed.data

  if (action === 'close') {
    const updated = await db.shortExcessRecord.update({
      where: { id: params.id },
      data: { status: 'closed', closedAt: new Date(), notes: parsed.data.notes ?? record.notes },
    })
    await createAuditLog({ userId: user!.id, action: 'UPDATE', tableName: 'short_excess_records', recordId: params.id, newValue: { status: 'closed' } })
    return NextResponse.json(updated)
  }

  if (action === 'send_to_planning') {
    await db.$transaction([
      db.shortExcessRecord.update({
        where: { id: params.id },
        data: { status: 'sent_to_planning' },
      }),
      db.poLineItem.update({
        where: { id: record.poLineItemId },
        data: {
          planningStatus: 'pending',
          directorBroadcastNote: `Shortage of ${Math.abs(record.varianceQty).toLocaleString('en-IN')} cartons — replan required`,
          directorCurrentStageKey: 'production',
        },
      }),
    ])
    await createAuditLog({ userId: user!.id, action: 'UPDATE', tableName: 'short_excess_records', recordId: params.id, newValue: { status: 'sent_to_planning' } })
    return NextResponse.json({ ok: true })
  }

  if (action === 'send_to_fg') {
    const { materialId, qty } = parsed.data
    const inv = await db.inventory.findUnique({ where: { id: materialId }, select: { id: true, qtyFg: true } })
    if (!inv) return NextResponse.json({ error: 'Inventory item not found' }, { status: 404 })

    await db.$transaction([
      db.shortExcessRecord.update({
        where: { id: params.id },
        data: { status: 'sent_to_fg' },
      }),
      db.inventory.update({
        where: { id: materialId },
        data: { qtyFg: { increment: qty } },
      }),
      db.stockMovement.create({
        data: {
          materialId,
          movementType: 'fg_receipt',
          qty,
          refType: 'short_excess',
          refId: params.id,
        },
      }),
    ])
    await createAuditLog({ userId: user!.id, action: 'UPDATE', tableName: 'short_excess_records', recordId: params.id, newValue: { status: 'sent_to_fg', materialId, qty } })
    return NextResponse.json({ ok: true })
  }
}
