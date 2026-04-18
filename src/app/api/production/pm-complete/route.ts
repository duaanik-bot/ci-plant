import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  PREVENTIVE_MAINTENANCE_AUDIT_MESSAGE,
  completePreventiveMaintenanceSignOff,
} from '@/lib/machine-pm-health'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  machineId: z.string().uuid(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const result = await completePreventiveMaintenanceSignOff(db, {
    machineId: parsed.data.machineId,
    verifiedByUserId: user!.id,
  })
  if (result.ok === false) {
    const st = result.error === 'Machine not found' ? 404 : 400
    return NextResponse.json({ error: result.error }, { status: st })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'machines',
    recordId: parsed.data.machineId,
    newValue: {
      preventiveMaintenanceAudit: PREVENTIVE_MAINTENANCE_AUDIT_MESSAGE,
      verifiedAt: new Date().toISOString(),
      industrialSignatory: 'Anik Dua',
    },
  })

  return NextResponse.json({
    ok: true,
    message: PREVENTIVE_MAINTENANCE_AUDIT_MESSAGE,
  })
}
