import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { PERFORMANCE_INCENTIVE_AUDIT_MESSAGE } from '@/lib/operator-performance'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  productionJobCardId: z.string().uuid(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const ledger = await db.productionOeeLedger.findUnique({
    where: { productionJobCardId: parsed.data.productionJobCardId },
  })
  if (!ledger) {
    return NextResponse.json({ error: 'Production ledger not found for job' }, { status: 404 })
  }
  if (!ledger.incentiveEligible) {
    return NextResponse.json({ error: 'Job is not incentive-eligible' }, { status: 400 })
  }
  if (ledger.incentiveVerifiedAt) {
    return NextResponse.json({ error: 'Incentive already verified' }, { status: 400 })
  }

  const updated = await db.productionOeeLedger.update({
    where: { id: ledger.id },
    data: { incentiveVerifiedAt: new Date() },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'production_oee_ledgers',
    recordId: ledger.id,
    newValue: {
      incentiveVerifiedAt: updated.incentiveVerifiedAt?.toISOString(),
      performanceIncentiveAudit: PERFORMANCE_INCENTIVE_AUDIT_MESSAGE,
      productionJobCardId: ledger.productionJobCardId,
    },
  })

  return NextResponse.json({
    ok: true,
    incentiveVerifiedAt: updated.incentiveVerifiedAt?.toISOString(),
    message: PERFORMANCE_INCENTIVE_AUDIT_MESSAGE,
  })
}
