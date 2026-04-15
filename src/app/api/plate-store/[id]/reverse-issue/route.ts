import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonParse } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  rackNumber: z.string().min(1, 'Rack number is required'),
})

/** Undo mistaken issue: return plate to live inventory without a full custody return. */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const raw = safeJsonParse<unknown>(await req.text(), {})
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json(
      { error: first?.message ?? 'Validation failed' },
      { status: 400 },
    )
  }

  const plate = await db.plateStore.findUnique({ where: { id } })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })
  if (plate.status !== 'issued') {
    return NextResponse.json(
      { error: 'Only plates currently issued to the floor can be reversed' },
      { status: 409 },
    )
  }

  const rack = parsed.data.rackNumber.trim()

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.plateStore.update({
      where: { id },
      data: {
        status: 'ready',
        issuedTo: null,
        issuedAt: null,
        rackLocation: rack,
        rackNumber: rack,
        slotNumber: rack,
      },
    })
    await tx.auditLog.create({
      data: {
        userId: user!.id,
        action: 'UPDATE',
        tableName: 'plate_store',
        recordId: id,
        newValue: { action: 'reverse_issue', rackNumber: rack } as object,
      },
    })
    return u
  })

  return NextResponse.json({ ok: true, plate: updated })
}
