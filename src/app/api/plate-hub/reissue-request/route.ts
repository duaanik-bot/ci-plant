import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  plateStoreId: z.string().uuid(),
  note: z.string().optional(),
})

/** High-priority CTP / vendor signal for a replacement plate set. */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const plate = await db.plateStore.findUnique({
    where: { id: parsed.data.plateStoreId },
    select: { id: true, plateSetCode: true, cartonName: true, status: true },
  })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'plate_reissue_requests',
    recordId: plate.id,
    newValue: {
      plateSetCode: plate.plateSetCode,
      cartonName: plate.cartonName,
      status: plate.status,
      priority: 'HIGH',
      note: parsed.data.note ?? null,
    },
  })

  return NextResponse.json({ ok: true, reference: `RI-${Date.now()}`, plateSetCode: plate.plateSetCode })
}
