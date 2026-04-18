import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import { HIGH_PRIORITY_ISSUE_AUDIT_MESSAGE } from '@/lib/paper-interconnect'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  paperWarehouseId: z.string().uuid(),
  productionJobCardId: z.string().uuid().optional().nullable(),
  qtySheets: z.number().int().positive(),
  highPriorityAuthorized: z.boolean().optional(),
})

function isFloorLoc(loc: string | null): boolean {
  return (loc ?? '').trim().toUpperCase() === 'FLOOR'
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.flatten() }, { status: 400 })
  }

  const { paperWarehouseId, productionJobCardId, qtySheets, highPriorityAuthorized } = parsed.data
  const operatorName = user!.name?.trim() || 'User'

  const result = await db.$transaction(async (tx) => {
    const src = await tx.paperWarehouse.findUnique({ where: { id: paperWarehouseId } })
    if (!src || src.qtySheets <= 0) {
      return { ok: false as const, code: 404 as const, message: 'Batch not found or empty' }
    }
    if (isFloorLoc(src.location)) {
      return { ok: false as const, code: 409 as const, message: 'Issue from main warehouse only (not a floor split row)' }
    }
    if (qtySheets > src.qtySheets) {
      return {
        ok: false as const,
        code: 409 as const,
        message: `Cannot exceed on-hand ${src.qtySheets} sheets`,
      }
    }

    let highPri = highPriorityAuthorized === true
    if (productionJobCardId) {
      const jc = await tx.productionJobCard.findUnique({
        where: { id: productionJobCardId },
        select: { jobCardNumber: true },
      })
      if (!jc) return { ok: false as const, code: 404 as const, message: 'Job card not found' }
      const poLine = await tx.poLineItem.findFirst({
        where: { jobCardNumber: jc.jobCardNumber },
        include: { po: { select: { isPriority: true } } },
      })
      if (poLine && (poLine.directorPriority || poLine.po.isPriority)) {
        highPri = true
      }
    }

    await tx.paperWarehouse.update({
      where: { id: src.id },
      data: { qtySheets: src.qtySheets - qtySheets },
    })

    const dest = await tx.paperWarehouse.create({
      data: {
        vendorId: src.vendorId,
        paperType: src.paperType,
        boardGrade: src.boardGrade,
        gsm: src.gsm,
        caliperMicrons: src.caliperMicrons,
        qtySheets,
        lotNumber: src.lotNumber,
        rate: src.rate,
        coaReference: src.coaReference,
        receiptDate: src.receiptDate,
        location: 'FLOOR',
        supplierGsm: src.supplierGsm,
        status: src.status,
        originatedFromId: src.id,
      },
    })

    const issue = await tx.paperIssueToFloor.create({
      data: {
        sourcePaperWarehouseId: src.id,
        destinationWarehouseId: dest.id,
        productionJobCardId: productionJobCardId ?? null,
        qtySheets,
        operatorUserId: user!.id,
        operatorName,
        highPriorityAuthorized: highPri,
      },
    })

    return { ok: true as const, issueId: issue.id, destinationId: dest.id, highPri }
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.code })
  }

  const auditPayload: Record<string, unknown> = {
    paperWarehouseId,
    qtySheets,
    productionJobCardId: productionJobCardId ?? null,
    destinationWarehouseId: result.destinationId,
    operatorName,
  }

  if (result.highPri) {
    auditPayload.highPriorityIssuance = HIGH_PRIORITY_ISSUE_AUDIT_MESSAGE
    await logIndustrialStatusChange({
      userId: user!.id,
      action: 'paper_issue_floor_high_priority',
      module: 'PaperIssueToFloor',
      recordId: result.issueId,
      operatorLabel: 'Anik Dua',
      payload: { message: HIGH_PRIORITY_ISSUE_AUDIT_MESSAGE, ...auditPayload },
    })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'paper_issue_to_floor',
    recordId: result.issueId,
    newValue: auditPayload,
  })

  return NextResponse.json({
    success: true,
    issueId: result.issueId,
    destinationWarehouseId: result.destinationId,
    highPriorityLogged: result.highPri,
  })
}
