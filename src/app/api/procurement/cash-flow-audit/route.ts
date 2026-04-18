import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  requirementKey: z.string().min(1).max(200),
  projectedPaymentYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  vendorPoNumber: z.string().max(64).optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const message = 'Cash Flow Optimized - Payment Timeline Generated.'
  const actor = user!.name?.trim() || 'User'

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'procurement_cash_flow_optimizer',
    recordId: parsed.data.requirementKey.slice(0, 120),
    newValue: {
      message,
      projectedPaymentYmd: parsed.data.projectedPaymentYmd ?? null,
      vendorPoNumber: parsed.data.vendorPoNumber ?? null,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'procurement_cash_flow_timeline',
    module: 'Procurement',
    recordId: 'cash-flow-optimizer',
    operatorLabel: actor,
    payload: {
      message,
      requirementKey: parsed.data.requirementKey,
      projectedPaymentYmd: parsed.data.projectedPaymentYmd ?? null,
      vendorPoNumber: parsed.data.vendorPoNumber ?? null,
    },
  })

  return NextResponse.json({ ok: true, message })
}
