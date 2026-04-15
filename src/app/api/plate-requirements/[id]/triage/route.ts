import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  channel: z.enum(['stock_available', 'inhouse_ctp', 'outside_vendor']),
  /** Row-col key (e.g. `2-3`) when assigning from Live Rack for stock path */
  rackSlot: z.string().min(1).optional(),
})

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid channel' }, { status: 400 })
  }

  const existing = await db.plateRequirement.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const channel = parsed.data.channel
  let nextStatus = existing.status
  if (channel === 'inhouse_ctp') nextStatus = 'ctp_internal_queue'
  if (channel === 'outside_vendor') nextStatus = 'awaiting_vendor_delivery'
  if (channel === 'stock_available') nextStatus = 'awaiting_rack_slot'

  const updated = await db.plateRequirement.update({
    where: { id },
    data: {
      triageChannel: channel,
      status: nextStatus,
      ...(channel === 'stock_available' && parsed.data.rackSlot
        ? { reservedRackSlot: parsed.data.rackSlot.trim() }
        : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_requirements',
    recordId: id,
    newValue: { triageChannel: channel, status: nextStatus },
  })

  return NextResponse.json({ ok: true, requirement: updated })
}
