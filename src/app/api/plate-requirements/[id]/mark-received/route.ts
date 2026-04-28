import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** POST — mark CTP/vendor queue requirement as received (persisted). */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const raw = (await req.json().catch(() => ({}))) as { lane?: string }
  const lane = String(raw.lane ?? '').trim()
  if (lane !== 'ctp' && lane !== 'vendor') {
    return NextResponse.json({ error: 'lane must be ctp or vendor' }, { status: 400 })
  }

  const row = await db.plateRequirement.findUnique({ where: { id } })
  if (!row) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })

  const ctpOk =
    lane === 'ctp' &&
    row.triageChannel === 'inhouse_ctp' &&
    (row.status === 'ctp_internal_queue' || row.status === 'ctp_received')
  const vendorOk =
    lane === 'vendor' &&
    row.triageChannel === 'outside_vendor' &&
    (row.status === 'awaiting_vendor_delivery' || row.status === 'vendor_received')

  if (!ctpOk && !vendorOk) {
    return NextResponse.json({ error: 'Requirement is not in the expected queue' }, { status: 409 })
  }

  await db.plateRequirement.update({
    where: { id },
    data: {
      status: lane === 'ctp' ? 'ctp_received' : 'vendor_received',
      lastStatusUpdatedAt: new Date(),
    },
  })

  return NextResponse.json({ ok: true })
}
