import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import { formatQualityPenaltyProofLines } from '@/lib/vendor-quality-penalty'

export const dynamic = 'force-dynamic'

const FINANCE_FINALIZER = 'Saachi'

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string; receiptId: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id: vendorPoId, receiptId } = await context.params

  const receipt = await db.vendorMaterialReceipt.findFirst({
    where: { id: receiptId, vendorPoId },
    include: {
      vendorPo: { select: { id: true, supplierId: true, poNumber: true } },
      qualityDebitNote: { select: { id: true } },
    },
  })
  if (!receipt) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })

  const penaltyTrancheKg =
    receipt.qtyAcceptedPenalty != null ? Number(receipt.qtyAcceptedPenalty) : 0
  const legacyPenaltyReceipt =
    receipt.qcStatus === 'PASSED_WITH_PENALTY' && receipt.qtyAcceptedPenalty == null

  if (!(penaltyTrancheKg > 0 || legacyPenaltyReceipt)) {
    return NextResponse.json(
      { error: 'Debit draft only applies to receipts with a penalty (GSM shortfall) tranche' },
      { status: 400 },
    )
  }
  if (receipt.qualityDebitNote) {
    return NextResponse.json({ error: 'Debit note draft already created for this receipt' }, { status: 409 })
  }
  const amt = receipt.qcPenaltyRecommendedInr
  if (amt == null || Number(amt) <= 0) {
    return NextResponse.json({ error: 'Missing penalty amount on receipt' }, { status: 400 })
  }

  const actualGsm = receipt.qcActualGsm != null ? Number(receipt.qcActualGsm) : null
  const rate = receipt.qcInvoiceRatePerKg != null ? Number(receipt.qcInvoiceRatePerKg) : null
  const shortfallPct = receipt.qcTechnicalShortfallPct != null ? Number(receipt.qcTechnicalShortfallPct) : null
  const qtyProof =
    penaltyTrancheKg > 0 ? penaltyTrancheKg : Number(receipt.receivedQty)

  if (actualGsm == null || rate == null || shortfallPct == null || !Number.isFinite(qtyProof) || qtyProof <= 0) {
    return NextResponse.json({ error: 'Incomplete QC penalty snapshot on receipt' }, { status: 400 })
  }

  const denom = 1 - shortfallPct / 100
  if (denom <= 0 || denom >= 1) {
    return NextResponse.json({ error: 'Invalid technical shortfall on receipt' }, { status: 400 })
  }
  const orderedGsmNum = actualGsm / denom
  if (!Number.isFinite(orderedGsmNum) || orderedGsmNum <= actualGsm) {
    return NextResponse.json({ error: 'Could not reconstruct ordered GSM for debit draft' }, { status: 400 })
  }

  const formulaProof = formatQualityPenaltyProofLines({
    orderedGsm: orderedGsmNum,
    actualGsm,
    invoiceRatePerKg: rate,
    receivedQtyKg: Number(receipt.receivedQty),
    penaltyQtyKg: penaltyTrancheKg > 0 ? penaltyTrancheKg : undefined,
    shortfallPct,
    valueLossInr: Number(amt),
  }).join('\n')

  const operatorName = user!.name?.trim() || 'User'
  const settlementMessage = `Quality Settlement Authorized by ${operatorName} - Pending Financial Finalization by ${FINANCE_FINALIZER}.`

  const note = await db.vendorQualityDebitNote.create({
    data: {
      receiptId,
      vendorPoId,
      supplierId: receipt.vendorPo.supplierId,
      orderedGsm: orderedGsmNum,
      actualGsm,
      technicalShortfallPct: shortfallPct,
      invoiceRatePerKg: rate,
      receivedQtyKg: qtyProof,
      amountInr: Number(amt),
      status: 'draft_pending_finance',
      formulaProof,
      authorizedByUserId: user!.id,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'vendor_quality_debit_notes',
    recordId: note.id,
    newValue: {
      receiptId,
      vendorPoId,
      poNumber: receipt.vendorPo.poNumber,
      amountInr: Number(amt),
      status: note.status,
      message: settlementMessage,
      formulaProof,
      penaltyTrancheKg: qtyProof,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'vendor_quality_debit_draft_ledger',
    module: 'VendorQualityDebit',
    recordId: note.id,
    operatorLabel: operatorName,
    payload: {
      receiptId,
      vendorPoId,
      supplierId: receipt.vendorPo.supplierId,
      amountInr: Number(amt),
      penaltyTrancheKg: qtyProof,
      settlementMessage,
      financeFinalizer: FINANCE_FINALIZER,
      timestampIso: new Date().toISOString(),
    },
  })

  return NextResponse.json({
    ok: true,
    debitNoteId: note.id,
    amountInr: Number(amt),
    status: note.status,
    message: settlementMessage,
  })
}
