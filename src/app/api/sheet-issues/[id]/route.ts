import { NextRequest, NextResponse } from 'next/server'
import { requireRole, requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  reasonCode: z.enum(['substrate_quality', 'machine_setting', 'colour_standard', 'die_cutting_waste', 'other']),
  reasonDetail: z.string().optional(),
})

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole(
    'stores',
    'shift_supervisor',
    'production_manager',
    'operations_head',
    'md'
  )
  if (error) return error

  const { id } = await context.params
  const parsed = updateSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const issue = await db.sheetIssue.findUnique({
    where: { id },
  })
  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!issue.isExcess || issue.approvedAt || issue.rejectedAt) {
    return NextResponse.json(
      { error: 'Only pending excess requests can be updated' },
      { status: 400 }
    )
  }

  await db.sheetIssue.update({
    where: { id },
    data: {
      reasonCode: parsed.data.reasonCode,
      reasonDetail: parsed.data.reasonCode === 'other' ? parsed.data.reasonDetail : parsed.data.reasonDetail ?? null,
    },
  })

  return NextResponse.json({ success: true, message: 'Excess request updated.' })
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const issue = await db.sheetIssue.findUnique({
    where: { id },
    include: {
      job: { select: { jobNumber: true, productName: true } },
      material: { select: { materialCode: true, description: true, unit: true } },
      bomLine: { select: { qtyApproved: true } },
    },
  })
  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const issuedSum = await db.sheetIssue.aggregate({
    where: {
      bomLineId: issue.bomLineId,
      OR: [
        { isExcess: false },
        { isExcess: true, approvedAt: { not: null }, rejectedAt: null },
      ],
      id: { not: issue.id },
    },
    _sum: { qtyRequested: true },
  })
  const approved = Number(issue.bomLine.qtyApproved)
  const alreadyIssued = Number(issuedSum._sum.qtyRequested ?? 0)

  return NextResponse.json({
    id: issue.id,
    jobId: issue.jobId,
    jobNumber: issue.job.jobNumber,
    productName: issue.job.productName,
    materialCode: issue.material.materialCode,
    materialDescription: issue.material.description,
    unit: issue.material.unit,
    qtyApproved: approved,
    qtyAlreadyIssued: alreadyIssued,
    qtyRequested: Number(issue.qtyRequested),
    reasonCode: issue.reasonCode,
    reasonDetail: issue.reasonDetail,
    isExcess: issue.isExcess,
    approvedAt: issue.approvedAt?.toISOString() ?? null,
    rejectedAt: issue.rejectedAt?.toISOString() ?? null,
  })
}
