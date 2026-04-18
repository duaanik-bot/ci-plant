import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import { safetyBufferAuditMessage } from '@/lib/reorder-radar'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  radarKey: z.string().min(1).max(256),
  minimumThreshold: z.number().int().min(0),
  maximumBuffer: z.number().int().min(0),
})

export async function PATCH(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.flatten() }, { status: 400 })
  }

  const { radarKey, minimumThreshold, maximumBuffer } = parsed.data
  const actor = user!.name?.trim() || 'User'

  const row = await db.paperSpecReorderPolicy.upsert({
    where: { radarKey },
    create: {
      radarKey,
      minimumThreshold,
      maximumBuffer,
    },
    update: {
      minimumThreshold,
      maximumBuffer,
    },
  })

  const msg = safetyBufferAuditMessage(actor)
  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'paper_spec_reorder_policies',
    recordId: row.id,
    newValue: {
      safetyBufferAudit: msg,
      radarKey,
      minimumThreshold,
      maximumBuffer,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'paper_spec_reorder_policy_upsert',
    module: 'PaperSpecReorderPolicy',
    recordId: row.id,
    operatorLabel: actor,
    payload: { message: msg, radarKey, minimumThreshold, maximumBuffer },
  })

  return NextResponse.json({
    ok: true,
    policy: {
      radarKey: row.radarKey,
      minimumThreshold: row.minimumThreshold,
      maximumBuffer: row.maximumBuffer,
    },
  })
}
