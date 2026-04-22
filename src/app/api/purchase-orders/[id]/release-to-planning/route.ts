import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { computeProductionKitForPo } from '@/lib/production-kit-status'
import { withDefaultPrePressAuditLead } from '@/lib/pre-press-defaults'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  /** If tooling kit is not all-green, the client must set this to proceed. */
  acknowledgeToolingGaps: z.boolean().optional(),
})

const RELEASABLE = new Set(['confirmed', 'approved'])

/**
 * Commits a confirmed PO to Planning: one planning row per line already exists in `po_line_items`.
 * This stamps release metadata, sets header status, and locks the PO for broad edits.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id: poId } = await context.params
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  const { acknowledgeToolingGaps = false } = parsed.data

  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: { lineItems: { orderBy: { createdAt: 'asc' } } },
  })
  if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 })

  if (po.status === 'sent_to_planning') {
    return NextResponse.json({ error: 'This PO is already in Planning' }, { status: 409 })
  }
  if (po.status === 'closed') {
    return NextResponse.json({ error: 'Closed POs cannot be released' }, { status: 400 })
  }
  if (!RELEASABLE.has(String(po.status).toLowerCase())) {
    return NextResponse.json(
      { error: 'PO must be Confirmed or Approved before release', code: 'STATUS' },
      { status: 400 },
    )
  }
  if (!String(po.customerId).trim()) {
    return NextResponse.json({ error: 'Customer is required', code: 'CUSTOMER' }, { status: 400 })
  }
  if (!po.poDate) {
    return NextResponse.json({ error: 'PO date is required', code: 'PODATE' }, { status: 400 })
  }
  if (!po.deliveryRequiredBy) {
    return NextResponse.json(
      { error: 'Target delivery (Delivery required by) is required', code: 'DELIVERY' },
      { status: 400 },
    )
  }

  for (const li of po.lineItems) {
    if (!li.cartonName.trim() || li.quantity <= 0 || !String(li.cartonId ?? '').trim()) {
      return NextResponse.json(
        {
          error: 'Every line must have a linked product, carton name, and quantity greater than zero',
          code: 'LINES',
        },
        { status: 400 },
      )
    }
  }

  const kit = await computeProductionKitForPo(db, poId)
  if (!kit.allOk && !acknowledgeToolingGaps) {
    return NextResponse.json(
      {
        error: 'Tooling / shade checks are not all green. Review Production Readiness, or acknowledge to release anyway.',
        code: 'TOOLING',
        productionKit: kit,
      },
      { status: 409 },
    )
  }

  const now = new Date().toISOString()
  const actor = user!.name?.trim() || user!.email || 'user'

  await db.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: poId },
      data: { status: 'sent_to_planning' },
    })
    for (const li of po.lineItems) {
      const prev = (li.specOverrides as Record<string, unknown> | null) || {}
      const merged = withDefaultPrePressAuditLead({
        ...prev,
        releasedToPlanningAt: now,
        releasedToPlanningBy: actor,
        releaseToolingOverride: !kit.allOk && acknowledgeToolingGaps,
      })
      await tx.poLineItem.update({
        where: { id: li.id },
        data: { specOverrides: merged as object },
      })
    }
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_orders',
    recordId: poId,
    newValue: { releaseToPlanning: true, at: now, lineCount: po.lineItems.length, toolingAllOk: kit.allOk },
  })

  return NextResponse.json({ ok: true, movedAt: now, poId, productionKit: kit })
}
