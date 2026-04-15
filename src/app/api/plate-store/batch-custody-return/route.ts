import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonParse } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  operatorUserId: z.string().uuid(),
  rackSlot: z.string().min(1),
  items: z
    .array(
      z.object({
        plateStoreId: z.string().uuid(),
        impressionsRun: z.number().int().min(0),
        plateCondition: z.enum(['Good', 'Damaged', 'Needs Repair']),
      }),
    )
    .min(1),
})

/** Return multiple plate sets to rack in a single transaction (no partial success). */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const text = await req.text()
  const raw = safeJsonParse<unknown>(text, {})
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json(
      {
        error: first
          ? `Missing or invalid field: ${first.path.join('.') || 'body'}`
          : 'Validation failed',
        details: parsed.error.flatten(),
      },
      { status: 400 },
    )
  }

  const { operatorUserId, rackSlot, items } = parsed.data
  const operator = await db.user.findUnique({
    where: { id: operatorUserId },
    select: { name: true },
  })
  if (!operator) return NextResponse.json({ error: 'Operator not found' }, { status: 404 })

  const rack = rackSlot.trim()
  const ids = Array.from(new Set(items.map((i) => i.plateStoreId)))
  const found = await db.plateStore.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  })
  if (found.length !== ids.length) {
    return NextResponse.json({ error: 'One or more plate sets were not found' }, { status: 400 })
  }

  await db.$transaction(async (tx) => {
    for (const item of items) {
      await tx.plateStore.update({
        where: { id: item.plateStoreId },
        data: {
          status: 'returned',
          returnedBy: operator.name,
          returnedAt: new Date(),
          rackLocation: rack,
          slotNumber: rack,
          issuedTo: null,
          issuedAt: null,
          totalImpressions: { increment: item.impressionsRun },
          lastUsedDate: new Date(),
          storageNotes: `Return condition: ${item.plateCondition}. Impressions (run): ${item.impressionsRun}.`,
        },
      })

      await tx.auditLog.create({
        data: {
          userId: user!.id,
          action: 'UPDATE',
          tableName: 'plate_store',
          recordId: item.plateStoreId,
          newValue: {
            action: 'custody_return_batch',
            impressionsRun: item.impressionsRun,
            plateCondition: item.plateCondition,
            rackSlot: rack,
          } as object,
        },
      })
    }
  })

  return NextResponse.json({ ok: true, count: items.length })
}
