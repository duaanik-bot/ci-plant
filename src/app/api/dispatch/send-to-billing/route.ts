import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const DISPATCH_TAG = 'dispatch-queue'
const BILLING_TAG = 'billing-queue'

const schema = z.object({
  dispatchIds: z.array(z.string().uuid()).min(1),
})

/**
 * Bulk handshake: marks one or more dispatches as ready for the billing engine.
 * The actual invoice generation lives under /billing/new and only considers
 * dispatches with billing_status='sent_to_billing'.
 */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { dispatchIds } = parsed.data

  // Only flip dispatches that are dispatched/QA-released and still in the not_sent state.
  // Already-billed rows stay as-is.
  const updated = await db.dispatch.updateMany({
    where: {
      id: { in: dispatchIds },
      billingStatus: 'not_sent',
      status: { in: ['dispatched', 'qa_released', 'pod_received'] },
    },
    data: { billingStatus: 'sent_to_billing' },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'dispatches',
    recordId: 'bulk',
    newValue: {
      mode: 'send_to_billing',
      dispatchIds,
      updatedCount: updated.count,
    },
  })

  revalidateTag(DISPATCH_TAG)
  revalidateTag(BILLING_TAG)
  return NextResponse.json({
    success: true,
    updated: updated.count,
    skipped: dispatchIds.length - updated.count,
  })
}
