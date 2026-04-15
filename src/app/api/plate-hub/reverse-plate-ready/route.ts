import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  kind: z.enum(['requirement', 'plate']),
  id: z.string().uuid(),
})

/** Undo Mark Plate Ready — return item to CTP, vendor lane, or rack. */
export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { kind, id } = parsed.data

  try {
    if (kind === 'requirement') {
      const row = await db.plateRequirement.findUnique({ where: { id } })
      if (!row) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })
      if (row.status !== 'READY_ON_FLOOR') {
        return NextResponse.json({ error: 'Not on custody floor' }, { status: 409 })
      }

      let nextStatus: string
      if (row.triageChannel === 'inhouse_ctp') nextStatus = 'ctp_internal_queue'
      else if (row.triageChannel === 'outside_vendor') nextStatus = 'awaiting_vendor_delivery'
      else {
        return NextResponse.json({ error: 'Cannot infer return lane' }, { status: 409 })
      }

      await db.plateRequirement.update({
        where: { id },
        data: { status: nextStatus },
      })
      return NextResponse.json({ ok: true })
    }

    const plate = await db.plateStore.findUnique({ where: { id } })
    if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })
    if (plate.status !== 'READY_ON_FLOOR') {
      return NextResponse.json({ error: 'Not on custody floor' }, { status: 409 })
    }

    const prev = String(plate.hubPreviousStatus ?? '').trim() || 'ready'
    await db.plateStore.update({
      where: { id },
      data: {
        status: prev,
        hubCustodySource: null,
        hubPreviousStatus: null,
      },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[reverse-plate-ready]', e)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }
}
