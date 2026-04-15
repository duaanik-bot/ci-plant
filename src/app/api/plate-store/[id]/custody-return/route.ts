import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonParse } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  impressionsRun: z.number().int().min(0),
  plateCondition: z.enum(['Good', 'Damaged', 'Needs Repair']),
  rackSlot: z.string().min(1),
  operatorUserId: z.string().uuid(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const text = await req.text()
  const raw = safeJsonParse<unknown>(text, {})
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const plate = await db.plateStore.findUnique({ where: { id } })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })

  const operator = await db.user.findUnique({
    where: { id: parsed.data.operatorUserId },
    select: { name: true },
  })
  if (!operator) return NextResponse.json({ error: 'Operator not found' }, { status: 404 })

  const impressions = parsed.data.impressionsRun
  const rack = parsed.data.rackSlot.trim()

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.plateStore.update({
      where: { id },
      data: {
        status: 'returned',
        returnedBy: operator.name,
        returnedAt: new Date(),
        rackLocation: rack,
        slotNumber: rack,
        issuedTo: null,
        issuedAt: null,
        totalImpressions: { increment: impressions },
        lastUsedDate: new Date(),
        storageNotes: `Return condition: ${parsed.data.plateCondition}. Impressions (run): ${impressions}.`,
      },
    })
    await tx.auditLog.create({
      data: {
        userId: user!.id,
        action: 'UPDATE',
        tableName: 'plate_store',
        recordId: id,
        newValue: {
          action: 'custody_return',
          impressionsRun: impressions,
          plateCondition: parsed.data.plateCondition,
          rackSlot: rack,
        } as object,
      },
    })
    return u
  })

  return NextResponse.json({ ok: true, plate: updated })
}
