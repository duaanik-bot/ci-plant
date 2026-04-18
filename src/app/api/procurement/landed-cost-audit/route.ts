import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  vendorMaterialLineId: z.string().uuid(),
  landedRatePerKg: z.number().nonnegative(),
  vendorPoNumber: z.string().max(64).optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const lr = Math.round(parsed.data.landedRatePerKg * 100) / 100
  const message = `True Landed Cost Calculated: ₹${lr.toFixed(2)} - Verified for Margin Audit.`
  const actor = user!.name?.trim() || 'User'

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'procurement_landed_cost',
    recordId: parsed.data.vendorMaterialLineId,
    newValue: {
      message,
      landedRatePerKg: lr,
      vendorPoNumber: parsed.data.vendorPoNumber ?? null,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'procurement_landed_cost_verified',
    module: 'Procurement',
    recordId: 'landed-cost',
    operatorLabel: actor,
    payload: {
      message,
      vendorMaterialLineId: parsed.data.vendorMaterialLineId,
      landedRatePerKg: lr,
      vendorPoNumber: parsed.data.vendorPoNumber ?? null,
    },
  })

  return NextResponse.json({ ok: true, message })
}
