import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonParse } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  plateStoreId: z.string().uuid(),
  machineId: z.string().uuid(),
  operatorUserId: z.string().uuid(),
  artworkId: z.string().min(1),
  jobCardId: z.string().min(1),
  setNumber: z.string().min(1),
})

/** Issue a plate directly from hub staging (READY_ON_FLOOR) without planning queue. */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = safeJsonParse<unknown>(await req.text(), {})
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json(
      { error: first?.message ?? 'Validation failed' },
      { status: 400 },
    )
  }

  const { plateStoreId, machineId, operatorUserId, artworkId, jobCardId, setNumber } =
    parsed.data

  const plate = await db.plateStore.findUnique({ where: { id: plateStoreId } })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })
  if (plate.status !== 'READY_ON_FLOOR') {
    return NextResponse.json(
      { error: 'Only plates on custody staging can be emergency-issued' },
      { status: 409 },
    )
  }

  const [machine, operator] = await Promise.all([
    db.machine.findUnique({ where: { id: machineId } }),
    db.user.findUnique({ where: { id: operatorUserId }, select: { name: true } }),
  ])
  if (!machine) return NextResponse.json({ error: 'Machine not found' }, { status: 404 })
  if (!operator) return NextResponse.json({ error: 'Operator not found' }, { status: 404 })

  const label = `${machine.machineCode} / ${operator.name}`

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.plateStore.update({
      where: { id: plateStoreId },
      data: {
        status: 'issued',
        issuedTo: label,
        issuedAt: new Date(),
        hubCustodySource: null,
        hubPreviousStatus: null,
        artworkId: artworkId || plate.artworkId,
        jobCardId: jobCardId || plate.jobCardId,
        slotNumber: setNumber || plate.slotNumber,
      },
    })
    await tx.auditLog.create({
      data: {
        userId: user!.id,
        action: 'UPDATE',
        tableName: 'plate_store',
        recordId: plateStoreId,
        newValue: {
          action: 'emergency_issue_bypass',
          machineId,
          operatorUserId,
        } as object,
      },
    })
    return u
  })

  return NextResponse.json({ ok: true, plate: updated })
}
