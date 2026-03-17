import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const storeSchema = z.object({
  collectedBy: z.string().min(1),
  storageLocation: z.string().optional().nullable(),
  storageNotes: z.string().optional().nullable(),
  colourConditions: z.record(z.string(), z.enum(['good', 'fair', 'degraded'])).optional(),
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
      status: 'stored',
      collectedBy: parsed.data.collectedBy,
      collectedAt: now,
      storageLocation: parsed.data.storageLocation ?? existing.storageLocation,
      storageNotes: parsed.data.storageNotes ?? existing.storageNotes,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'plate_store',
    recordId: id,
    oldValue: { status: existing.status },
    newValue: { status: updated.status, collectedBy: updated.collectedBy, collectedAt: updated.collectedAt },
  })

  return NextResponse.json(updated)
}
