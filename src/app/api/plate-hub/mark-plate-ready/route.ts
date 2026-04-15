import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  kind: z.enum(['requirement', 'plate']),
  id: z.string().uuid(),
})

/** Move CTP / vendor requirement or rack plate into Custody Floor (preparation staging). */
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

      const okCtp =
        row.triageChannel === 'inhouse_ctp' && row.status === 'ctp_internal_queue'
      const okVendor =
        row.triageChannel === 'outside_vendor' && row.status === 'awaiting_vendor_delivery'
      if (!okCtp && !okVendor) {
        return NextResponse.json(
          { error: 'Requirement is not in CTP queue or vendor lane' },
          { status: 409 },
        )
      }

      await db.plateRequirement.update({
        where: { id },
        data: { status: 'READY_ON_FLOOR', lastStatusUpdatedAt: new Date() },
      })
      return NextResponse.json({ ok: true })
    }

    const plate = await db.plateStore.findUnique({ where: { id } })
    if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })

    const rackOk = ['ready', 'returned', 'in_stock'].includes(plate.status)
    if (!rackOk) {
      return NextResponse.json(
        { error: 'Only rack inventory plates can be marked ready for custody' },
        { status: 409 },
      )
    }

    await db.plateStore.update({
      where: { id },
      data: {
        status: 'READY_ON_FLOOR',
        hubCustodySource: 'rack',
        hubPreviousStatus: plate.status,
        issuedTo: null,
        issuedAt: null,
        lastStatusUpdatedAt: new Date(),
      },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[mark-plate-ready]', e)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }
}
