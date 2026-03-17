import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

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
  if (needsOpsHead && approver?.role?.roleName !== 'operations_head' && approver?.role?.roleName !== 'md') {
    return NextResponse.json(
      { error: 'PR value > ₹50,000 requires Operations Head or MD approval' },
      { status: 403 }
    )
  }

  await db.purchaseRequisition.update({
    where: { id },
    data: {
      status: 'approved',
      approvedBy: user!.id,
      approvedAt: new Date(),
    },
  })

  return NextResponse.json({
    success: true,
    message: 'Purchase requisition approved.',
  })
}
