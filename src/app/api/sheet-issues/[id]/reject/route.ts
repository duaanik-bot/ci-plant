import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  rejectionReason: z.string().min(1, 'Reason is required'),
})

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole(
    'shift_supervisor',
    'production_manager',
    'operations_head',
    'md'
  )
  if (error) return error

  const { id } = await context.params
  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
      { status: 400 }
    )
  }

  const issue = await db.sheetIssue.findUnique({
    where: { id },
    include: { job: { select: { jobNumber: true } } },
  })

  if (!issue) {
    return NextResponse.json({ error: 'Sheet issue not found' }, { status: 404 })
  }
  if (!issue.isExcess) {
    return NextResponse.json({ error: 'Not an excess request' }, { status: 400 })
  }
  if (issue.approvedAt || issue.rejectedAt) {
    return NextResponse.json({ error: 'Request already processed' }, { status: 400 })
  }

  await db.sheetIssue.update({
    where: { id },
    data: {
      rejectedAt: new Date(),
      rejectionReason: parsed.data.rejectionReason,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'sheet_issues',
    recordId: id,
    newValue: { rejected: true, reason: parsed.data.rejectionReason },
  })

  return NextResponse.json({
    success: true,
    message: 'Excess request rejected.',
  })
}
