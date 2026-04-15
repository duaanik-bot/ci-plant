import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'
import { sheetIssueSchema } from '@/lib/validations'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  jobCardId: z.string().uuid(),
  qtyRequested: z.number().int().positive(),
  lotNumber: z.string().optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole(
    'stores',
    'shift_supervisor',
    'production_manager',
    'operations_head',
    'md',
  )
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'jobCardId and qtyRequested are required', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const { jobCardId, qtyRequested, lotNumber } = parsed.data

  const shared = sheetIssueSchema.safeParse({ jobCardId, qtyRequested, lotNumber })
  if (!shared.success) {
    const fields: Record<string, string> = {}
    shared.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const result = await db.$transaction(async (tx) => {
    const jc = await tx.productionJobCard.findUnique({
      where: { id: jobCardId },
    })
    if (!jc) return { success: false as const, message: 'Job card not found' }

    const remaining = Math.max(0, jc.totalSheets - jc.sheetsIssued)
    if (qtyRequested > remaining) {
      return {
        success: false as const,
        message: `Only ${remaining} sheets remaining. Requested ${qtyRequested}.`,
        remaining,
      }
    }

    await tx.sheetIssueRecord.create({
      data: {
        jobCardId,
        qtyRequested,
        isExcess: false,
        issuedBy: user!.id,
        approvedAt: new Date(),
        lotNumber: lotNumber || null,
      },
    })

    await tx.productionJobCard.update({
      where: { id: jobCardId },
      data: { sheetsIssued: { increment: qtyRequested } },
    })

    const newRemaining = remaining - qtyRequested
    return {
      success: true as const,
      message: `Issued ${qtyRequested} sheets. Remaining: ${newRemaining}.`,
      remaining: newRemaining,
      issuedQty: qtyRequested,
    }
  })

  if (result.success) {
    await createAuditLog({
      userId: user!.id,
      action: 'INSERT',
      tableName: 'sheet_issue_records',
      recordId: jobCardId,
      newValue: { qtyRequested, jobCardId },
    })
  }

  return NextResponse.json(result, { status: result.success ? 200 : 409 })
}
