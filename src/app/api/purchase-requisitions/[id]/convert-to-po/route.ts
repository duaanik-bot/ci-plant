import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  poReference: z.string().min(1).max(60),
  expectedDelivery: z.string().datetime().optional(),
})

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole(
    'stores',
    'production_manager',
    'operations_head',
    'md'
  )
  if (error) return error

  const { id } = await context.params
  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'poReference required', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const pr = await db.purchaseRequisition.findUnique({ where: { id } })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })
  if (pr.status !== 'approved') {
    return NextResponse.json(
      { error: 'Only approved PRs can be converted to PO' },
      { status: 400 }
    )
  }

  const expectedDelivery = parsed.data.expectedDelivery
    ? new Date(parsed.data.expectedDelivery)
    : undefined

  const updated = await db.purchaseRequisition.update({
    where: { id },
    data: {
      status: 'converted_to_po',
      poReference: parsed.data.poReference,
      expectedDelivery,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_requisitions',
    recordId: updated.id,
    oldValue: { status: pr.status },
    newValue: { status: updated.status, poReference: parsed.data.poReference },
  })

  return NextResponse.json({
    success: true,
    message: 'Marked as converted to PO.',
  })
}
