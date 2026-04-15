import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  reason: z.string().min(1),
})

/** Full scrap while plate is on floor (issued) — frees rack slot tracking. */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Reason required' }, { status: 400 })
  }

  const plate = await db.plateStore.findUnique({ where: { id } })
  if (!plate) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (plate.status !== 'issued') {
    return NextResponse.json({ error: 'Only plates currently on press can be scrapped from this action' }, { status: 409 })
  }

  const updated = await db.plateStore.update({
    where: { id },
    data: {
      status: 'destroyed',
      slotNumber: null,
      rackLocation: null,
      issuedTo: null,
      issuedAt: null,
      destroyedReason: parsed.data.reason,
      destroyedBy: user!.id,
      destroyedAt: new Date(),
      storageNotes: `Scrapped from floor: ${parsed.data.reason}`,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_store',
    recordId: id,
    newValue: { action: 'scrap_from_floor', reason: parsed.data.reason },
  })

  return NextResponse.json({ ok: true, plate: updated })
}
