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
  if (needsOpsHead && approver?.role?.roleName !== 'plant_head' && approver?.role?.roleName !== 'admin') {
    return NextResponse.json(
      { error: 'PR value > ₹50,000 requires Plant Head or Admin approval' },
      { status: 403 }
    )
  }

  const updated = await db.purchaseRequisition.update({
    where: { id },
    data: {
      status: 'approved',
      approvedBy: user!.id,
      approvedAt: new Date(),
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
