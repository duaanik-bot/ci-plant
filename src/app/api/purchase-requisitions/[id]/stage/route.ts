import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'
import { uiStageToDbStatus } from '@/lib/purchase-requisition-status'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const schema = z.object({
  stage: z.enum(['draft', 'approved', 'ordered', 'received']),
  poReference: z.string().max(60).optional().nullable(),
  expectedDelivery: z.string().datetime().optional().nullable(),
})

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireRole('admin', 'plant_head', 'accounts')
  if (error) return error

  const { id } = await context.params
  const parsed = schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const pr = await db.purchaseRequisition.findUnique({ where: { id } })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })

  const status = uiStageToDbStatus(parsed.data.stage)
  const expectedDelivery = parsed.data.expectedDelivery ? new Date(parsed.data.expectedDelivery) : null

  const updated = await db.$transaction(async (tx) => {
    const next = await tx.purchaseRequisition.update({
      where: { id },
      data: {
        status,
        ...(parsed.data.poReference !== undefined ? { poReference: parsed.data.poReference || null } : {}),
        ...(expectedDelivery ? { expectedDelivery } : {}),
        ...(parsed.data.stage === 'approved' ? { approvedBy: user!.id, approvedAt: new Date() } : {}),
      },
    })

    const qty = Number(pr.qtyRequired)
    const prevOrdered = pr.status === 'converted_to_po'
    const nextOrdered = next.status === 'converted_to_po'
    if (qty > 0 && prevOrdered !== nextOrdered) {
      const inv = await tx.inventory.findUnique({
        where: { id: pr.materialId },
        select: { qtyQuarantine: true },
      })
      if (inv) {
        const currentIncoming = Number(inv.qtyQuarantine)
        const target = nextOrdered
          ? currentIncoming + qty
          : Math.max(0, currentIncoming - qty)
        await tx.inventory.update({
          where: { id: pr.materialId },
          data: { qtyQuarantine: target },
        })
      }
    }
    return next
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_requisitions',
    recordId: updated.id,
    oldValue: { status: pr.status },
    newValue: { status: updated.status, stage: parsed.data.stage },
  })

  return NextResponse.json({
    success: true,
    id: updated.id,
    stage: parsed.data.stage,
    status: updated.status,
  })
}
