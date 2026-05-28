import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole(
    'admin',
    'md',
    'plant_head',
    'accounts'
  )
  if (error) return error

  const { id } = await context.params

  const pr = await db.purchaseRequisition.findUnique({
    where: { id },
    include: { material: true },
  })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })
  if (pr.status !== 'pending') {
    return NextResponse.json({ error: `PR is ${pr.status}, cannot approve` }, { status: 400 })
  }

  const value = Number(pr.estimatedValue)
  const needsOpsHead = value > 50000
  const approver = await db.user.findUnique({
    where: { id: user!.id },
    include: { role: true },
  })
  if (
    needsOpsHead &&
    approver?.role?.roleName !== 'plant_head' &&
    approver?.role?.roleName !== 'admin' &&
    approver?.role?.roleName !== 'md'
  ) {
    return NextResponse.json(
      { error: 'PR value > ₹50,000 requires MD, Plant Head or Admin approval' },
      { status: 403 }
    )
  }
  const linkedShortages = await db.materialShortage.findMany({
    where: { purchaseReqId: id, status: 'open' },
    select: { remainingQty: true, shortageQty: true, allocatedQty: true },
  })
  const linkedRequiredQty = linkedShortages.reduce((sum, s) => sum + Math.max(0, Number(s.remainingQty) || 0), 0)
  const linkedRequiredSheets = linkedShortages.reduce(
    (sum, s) => sum + Math.max(0, Math.round(Number(s.shortageQty ?? 0) + Number(s.allocatedQty ?? 0))),
    0,
  )

  const updated = await db.purchaseRequisition.update({
    where: { id },
    data: {
      status: 'approved',
      approvedBy: user!.id,
      approvedAt: new Date(),
      ...(linkedRequiredQty > 0 ? { qtyRequired: linkedRequiredQty } : {}),
      ...(linkedRequiredSheets > 0 ? { requiredSheets: linkedRequiredSheets } : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_requisitions',
    recordId: updated.id,
    oldValue: { status: pr.status },
    newValue: { status: updated.status },
  })

  return NextResponse.json({
    success: true,
    message: 'Purchase requisition approved.',
  })
}
