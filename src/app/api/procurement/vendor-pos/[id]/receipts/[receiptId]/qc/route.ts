import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { INDUSTRIAL_DEFAULT_OPERATOR, logIndustrialStatusChange } from '@/lib/industrial-audit'
import { GRN_REJECTION_REASONS } from '@/lib/grn-rejection-reasons'
import {
  receiptAccruedPayableInr,
  validateQtySplitSum,
  isGrnQcComplete,
} from '@/lib/grn-receipt-qc'
import { gsmDeviationRatio, invoiceRateFromVendorLines, orderedGsmFromVendorLines } from '@/lib/vendor-po-ordered-gsm'
import { syncVendorPoReceiptAggregate } from '@/lib/vendor-po-receipt-sync'
import { computeQualityPenaltyInr, formatQualityPenaltyProofLines } from '@/lib/vendor-quality-penalty'

export const dynamic = 'force-dynamic'

const GSM_CRITICAL_PCT = 0.05

const bodySchema = z.object({
  qcDetails: z.object({
    qtyAcceptedStandard: z.coerce.number().min(0),
    qtyAcceptedPenalty: z.coerce.number().min(0),
    qtyRejected: z.coerce.number().min(0),
    actualGsm: z.coerce.number().positive(),
    shadeMatch: z.boolean(),
    surfaceCleanliness: z.boolean(),
    qcRemarks: z.string().max(8000).optional().nullable(),
    rejectionReason: z.string().max(120).optional().nullable(),
    rejectionRemarks: z.string().max(8000).optional().nullable(),
  }),
})

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string; receiptId: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id: vendorPoId, receiptId } = await context.params

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid QC payload' }, { status: 400 })
  }

  const receipt = await db.vendorMaterialReceipt.findFirst({
    where: { id: receiptId, vendorPoId },
    include: {
      vendorPo: {
        include: { lines: { select: { gsm: true, totalWeightKg: true, ratePerKg: true } } },
      },
    },
  })
  if (!receipt) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
  if (isGrnQcComplete(receipt)) {
    return NextResponse.json({ error: 'QC already recorded for this receipt' }, { status: 409 })
  }

  const { qcDetails } = parsed.data
  const orderedGsm = orderedGsmFromVendorLines(receipt.vendorPo.lines)
  const invoiceRate = invoiceRateFromVendorLines(receipt.vendorPo.lines)
  const receivedQtyKg = Number(receipt.receivedQty)

  const std = qcDetails.qtyAcceptedStandard
  const pen = qcDetails.qtyAcceptedPenalty
  const rej = qcDetails.qtyRejected
  const sumCheck = validateQtySplitSum(receivedQtyKg, std, pen, rej)
  if (!sumCheck.ok) {
    return NextResponse.json(
      {
        error: `Split quantities must sum to received kg (${receivedQtyKg.toFixed(4)}); got ${sumCheck.sum.toFixed(4)}`,
      },
      { status: 400 },
    )
  }

  let rejectionReasonStored: string | null = null
  let rejectionRemarksStored: string | null = null
  if (rej > 0) {
    const reason = qcDetails.rejectionReason?.trim() ?? ''
    const rejRm = qcDetails.rejectionRemarks?.trim() ?? ''
    if (!reason || !(GRN_REJECTION_REASONS as readonly string[]).includes(reason)) {
      return NextResponse.json(
        { error: 'Rejected kg > 0 requires a valid rejection reason from the list' },
        { status: 400 },
      )
    }
    if (rejRm.length < 3) {
      return NextResponse.json(
        { error: 'Rejected kg > 0 requires rejection remarks (min 3 characters)' },
        { status: 400 },
      )
    }
    rejectionReasonStored = reason
    rejectionRemarksStored = rejRm
  }

  if (pen > 0) {
    if (invoiceRate == null || invoiceRate <= 0) {
      return NextResponse.json(
        { error: 'Penalty tranche requires invoice ₹/kg on the dominant vendor PO line' },
        { status: 400 },
      )
    }
    if (orderedGsm == null) {
      return NextResponse.json({ error: 'Cannot evaluate penalty tranche without ordered GSM' }, { status: 400 })
    }
    const penCalc = computeQualityPenaltyInr({
      invoiceRatePerKg: invoiceRate,
      receivedQtyKg: pen,
      actualGsm: qcDetails.actualGsm,
      orderedGsm,
    })
    if (!penCalc.eligible || penCalc.valueLossInr <= 0) {
      return NextResponse.json(
        {
          error:
            'Penalty tranche only applies when Actual GSM is below Ordered GSM (technical shortfall on that portion).',
        },
        { status: 400 },
      )
    }
  }

  const ratio =
    orderedGsm != null ? gsmDeviationRatio(qcDetails.actualGsm, orderedGsm) : null
  const criticalGsmVariance = ratio != null && ratio > GSM_CRITICAL_PCT

  const operatorName = (user!.name?.trim() || INDUSTRIAL_DEFAULT_OPERATOR).trim()
  const now = new Date()
  const remarks = qcDetails.qcRemarks?.trim() || null
  const usable = std + pen

  let verdict: 'PASSED' | 'FAILED' | 'PASSED_WITH_PENALTY'
  if (usable <= 0) {
    verdict = 'FAILED'
  } else if (pen > 0) {
    verdict = 'PASSED_WITH_PENALTY'
  } else {
    verdict = 'PASSED'
  }

  let penaltyRecommendedInr: number | null = null
  let technicalShortfallPct: number | null = null
  let penaltyProofLines: string[] | null = null

  if (pen > 0 && orderedGsm != null && invoiceRate != null) {
    const penRes = computeQualityPenaltyInr({
      invoiceRatePerKg: invoiceRate,
      receivedQtyKg: pen,
      actualGsm: qcDetails.actualGsm,
      orderedGsm,
    })
    penaltyRecommendedInr = penRes.valueLossInr
    technicalShortfallPct = penRes.technicalShortfallPct
    penaltyProofLines = formatQualityPenaltyProofLines({
      orderedGsm,
      actualGsm: qcDetails.actualGsm,
      invoiceRatePerKg: invoiceRate,
      receivedQtyKg: receivedQtyKg,
      penaltyQtyKg: pen,
      shortfallPct: penRes.technicalShortfallPct,
      valueLossInr: penRes.valueLossInr,
    })
  }

  const accrued = receiptAccruedPayableInr(
    {
      receivedQty: receipt.receivedQty,
      qcStatus: verdict,
      qtyAcceptedStandard: std,
      qtyAcceptedPenalty: pen,
      qtyRejected: rej,
      qcActualGsm: qcDetails.actualGsm,
      qcPenaltyRecommendedInr: penaltyRecommendedInr,
    },
    invoiceRate ?? 0,
    orderedGsm,
    { assumeNewSplit: true },
  )

  await db.$transaction(async (tx) => {
    await tx.vendorMaterialReceipt.update({
      where: { id: receiptId },
      data: {
        qtyAcceptedStandard: new Prisma.Decimal(std),
        qtyAcceptedPenalty: new Prisma.Decimal(pen),
        qtyRejected: new Prisma.Decimal(rej),
        rejectionReason: rejectionReasonStored,
        rejectionRemarks: rejectionRemarksStored,
        qcStatus: verdict,
        qcActualGsm: new Prisma.Decimal(qcDetails.actualGsm),
        qcShadeMatch: qcDetails.shadeMatch,
        qcSurfaceCleanliness: qcDetails.surfaceCleanliness,
        qcRemarks: remarks,
        qcPerformedByUserId: user!.id,
        qcPerformedAt: now,
        qcPenaltyRecommendedInr: penaltyRecommendedInr,
        qcInvoiceRatePerKg: pen > 0 && invoiceRate != null ? invoiceRate : null,
        qcTechnicalShortfallPct: technicalShortfallPct,
        qcAccruedPayableInr: new Prisma.Decimal(accrued),
      },
    })
    await syncVendorPoReceiptAggregate(tx, vendorPoId)
  })

  const poAfter = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id: vendorPoId },
    include: { lines: { select: { totalWeightKg: true } } },
  })

  const auditMessage = `QC split on GRN ${receipt.scaleSlipId}: stock ${std} kg · penalty ${pen} kg · return ${rej} kg · ${verdict} · GSM ${qcDetails.actualGsm}${orderedGsm != null ? ` vs ordered ${orderedGsm}` : ''} · by ${operatorName} @ ${now.toISOString()}${penaltyRecommendedInr != null ? ` · penalty ₹${penaltyRecommendedInr.toFixed(2)}` : ''}`

  const industrialAction =
    verdict === 'PASSED'
      ? 'vendor_material_receipt_qc_passed'
      : verdict === 'FAILED'
        ? 'vendor_material_receipt_qc_failed'
        : 'vendor_material_receipt_qc_passed_with_penalty'

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'vendor_material_receipts',
    recordId: receiptId,
    newValue: {
      qcStatus: verdict,
      qtyAcceptedStandard: std,
      qtyAcceptedPenalty: pen,
      qtyRejected: rej,
      qcDetails: {
        actualGsm: qcDetails.actualGsm,
        shadeMatch: qcDetails.shadeMatch,
        surfaceCleanliness: qcDetails.surfaceCleanliness,
        qcRemarks: remarks,
        qcPerformedByUserId: user!.id,
      },
      orderedGsm,
      invoiceRatePerKg: invoiceRate,
      penaltyRecommendedInr,
      technicalShortfallPct,
      penaltyProofLines,
      criticalGsmVariance,
      qcAccruedPayableInr: accrued,
      message: auditMessage,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: industrialAction,
    module: 'VendorMaterialPO',
    recordId: vendorPoId,
    operatorLabel: operatorName,
    payload: {
      receiptId,
      verdict,
      qtyAcceptedStandard: std,
      qtyAcceptedPenalty: pen,
      qtyRejected: rej,
      qcPerformedAtIso: now.toISOString(),
      actualGsm: qcDetails.actualGsm,
      orderedGsm,
      invoiceRatePerKg: invoiceRate,
      penaltyRecommendedInr,
      technicalShortfallPct,
      penaltyProofLines,
      criticalGsmVariance,
      qcAccruedPayableInr: accrued,
      auditMessage,
    },
  })

  return NextResponse.json({
    ok: true,
    qcStatus: verdict,
    qtyAcceptedStandard: std,
    qtyAcceptedPenalty: pen,
    qtyRejected: rej,
    orderedGsm,
    invoiceRatePerKg: invoiceRate,
    criticalGsmVariance,
    penaltyRecommendedInr,
    technicalShortfallPct,
    penaltyProofLines,
    qcAccruedPayableInr: accrued,
    totalUsableReceivedKg: poAfter ? Number(poAfter.totalUsableReceivedKg) : 0,
    totalReceivedKg: poAfter ? Number(poAfter.totalReceivedKg) : 0,
    accruedReceiptPayableInr: poAfter ? Number(poAfter.accruedReceiptPayableInr) : 0,
    status: poAfter?.status,
    message: auditMessage,
  })
}
