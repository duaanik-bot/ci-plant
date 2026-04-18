import { NextRequest, NextResponse } from 'next/server'
import { requireRole, createAuditLog } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'
import { sheetIssueSchema } from '@/lib/validations'
import {
  evaluateFifoForLot,
  fifoOverrideAuditMessage,
  jobFifoSpecFromPoLine,
} from '@/lib/inventory-aging-fifo'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  jobCardId: z.string().uuid(),
  qtyRequested: z.number().int().positive(),
  lotNumber: z.string().optional(),
  fifoSkipReason: z.string().max(600).optional(),
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

  const { jobCardId, qtyRequested, lotNumber, fifoSkipReason } = parsed.data

  const shared = sheetIssueSchema.safeParse({ jobCardId, qtyRequested, lotNumber })
  if (!shared.success) {
    const fields: Record<string, string> = {}
    shared.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const jcHead = await db.productionJobCard.findUnique({
    where: { id: jobCardId },
    select: { jobCardNumber: true },
  })
  if (!jcHead) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const poLine = await db.poLineItem.findFirst({
    where: { jobCardNumber: jcHead.jobCardNumber },
  })
  const fifoSpec = poLine ? jobFifoSpecFromPoLine(poLine) : null

  if (fifoSpec && (lotNumber ?? '').trim()) {
    const fifo = await evaluateFifoForLot(db, fifoSpec, lotNumber)
    if (fifo.violation) {
      const reason = (fifoSkipReason ?? '').trim()
      if (reason.length < 8) {
        return NextResponse.json(
          {
            success: false,
            fifoViolation: true,
            message:
              'FIFO violation: older stock exists for this GSM / grade / paper spec. Enter lot # and a reason to skip (min 8 characters), e.g. older stock inaccessible.',
            olderBatches: fifo.olderBatches,
          },
          { status: 409 },
        )
      }
    }
  }

  const actor = user!.name?.trim() || 'User'
  const fifoReasonTrim = (fifoSkipReason ?? '').trim()

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

    let fifoOverrideReason: string | null = null
    if (fifoSpec && (lotNumber ?? '').trim()) {
      const fifo = await evaluateFifoForLot(tx, fifoSpec, lotNumber)
      if (fifo.violation && fifoReasonTrim.length >= 8) {
        fifoOverrideReason = fifoReasonTrim
      }
    }

    const record = await tx.sheetIssueRecord.create({
      data: {
        jobCardId,
        qtyRequested,
        isExcess: false,
        issuedBy: user!.id,
        approvedAt: new Date(),
        lotNumber: lotNumber || null,
        fifoOverrideReason,
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
      recordId: record.id,
      fifoOverrideReason,
    }
  })

  if (!result.success) {
    return NextResponse.json(result, { status: 409 })
  }

  const insertPayload: Record<string, unknown> = {
    qtyRequested,
    jobCardId,
    lotNumber: lotNumber ?? null,
  }
  if (result.fifoOverrideReason) {
    const msg = fifoOverrideAuditMessage(actor, result.fifoOverrideReason)
    insertPayload.fifoOverrideAudit = msg
    insertPayload.fifoOverrideReason = result.fifoOverrideReason
    await logIndustrialStatusChange({
      userId: user!.id,
      action: 'stores_fifo_override',
      module: 'Inventory',
      recordId: result.recordId,
      operatorLabel: actor,
      payload: { message: msg },
    })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'sheet_issue_records',
    recordId: result.recordId,
    newValue: insertPayload,
  })

  return NextResponse.json({
    success: true,
    message: result.message,
    remaining: result.remaining,
    issuedQty: result.issuedQty,
  })
}
