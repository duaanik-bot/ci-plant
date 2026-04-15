import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const storeSchema = z.object({
  returnedBy: z.string().min(1),
  rackLocation: z.string().optional().nullable(),
  slotNumber: z.string().optional().nullable(),
  returnCondition: z.string().optional().nullable(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.plateStore.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = storeSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const now = new Date()
  const updated = await db.plateStore.update({
    where: { id },
    data: {
      status: 'returned',
      returnedBy: parsed.data.returnedBy,
      returnedAt: now,
      rackLocation: parsed.data.rackLocation ?? existing.rackLocation,
      slotNumber: parsed.data.slotNumber ?? existing.slotNumber,
      returnCondition: parsed.data.returnCondition ?? existing.returnCondition,
    },
  })

  await db.plateAuditLog.create({
    data: {
      plateStoreId: id,
      plateSetCode: updated.plateSetCode,
      action: 'returned',
      performedBy: user!.id,
      details: {
        returnedBy: parsed.data.returnedBy,
        rackLocation: updated.rackLocation,
        slotNumber: updated.slotNumber,
      },
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_store',
    recordId: id,
    oldValue: { status: existing.status },
    newValue: { status: updated.status, returnedBy: updated.returnedBy, returnedAt: updated.returnedAt },
  })

  return NextResponse.json(updated)
}
