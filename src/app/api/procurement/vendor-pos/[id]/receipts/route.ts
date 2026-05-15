import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { INDUSTRIAL_DEFAULT_OPERATOR, logIndustrialStatusChange } from '@/lib/industrial-audit'
import { isVendorPoPostDispatchReceiving } from '@/lib/vendor-po-post-dispatch'
import { isGrnQcComplete } from '@/lib/grn-receipt-qc'
import { formatQualityPenaltyProofLines } from '@/lib/vendor-quality-penalty'
import { invoiceRateFromVendorLines, orderedGsmFromVendorLines } from '@/lib/vendor-po-ordered-gsm'
import { sumOrderedKgFromLines, syncVendorPoReceiptAggregate } from '@/lib/vendor-po-receipt-sync'

export const dynamic = 'force-dynamic'

const postBodySchema = z.object({
  receiptDate: z.string().min(1),
  receivedQty: z.coerce.number().positive(),
  vehicleNumber: z.string().trim().min(1).max(64),
  scaleSlipId: z.string().trim().min(1).max(120),
})

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error
  const { id: vendorPoId } = await context.params

  const po = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id: vendorPoId },
    include: {
      lines: { select: { totalWeightKg: true, gsm: true, ratePerKg: true } },
      receipts: {
        orderBy: { receiptDate: 'desc' },
        include: { qualityDebitNote: { select: { id: true, status: true } } },
      },
    },
  })
  if (!po) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const orderedKg = sumOrderedKgFromLines(po.lines)
  const totalReceivedGrossKg = Number(po.totalReceivedKg)
  const totalUsableReceivedKg = Number(po.totalUsableReceivedKg)
  const outstandingKg = Math.max(0, orderedKg - totalUsableReceivedKg)
  const orderedGsm = orderedGsmFromVendorLines(po.lines)
  const invoiceRatePerKg = invoiceRateFromVendorLines(po.lines)
  const accruedReceiptPayableInr = Number(po.accruedReceiptPayableInr)

  let receiptBreakdownStockKg = 0
  let receiptBreakdownPenaltyKg = 0
  let receiptBreakdownReturnKg = 0
  for (const r of po.receipts) {
    if (r.qtyAcceptedStandard != null && r.qtyAcceptedPenalty != null && r.qtyRejected != null) {
      receiptBreakdownStockKg += Number(r.qtyAcceptedStandard)
      receiptBreakdownPenaltyKg += Number(r.qtyAcceptedPenalty)
      receiptBreakdownReturnKg += Number(r.qtyRejected)
    } else if (r.qcStatus === 'PASSED' || r.qcStatus === 'PASSED_WITH_PENALTY') {
      receiptBreakdownStockKg += Number(r.receivedQty)
    } else if (r.qcStatus === 'FAILED') {
      receiptBreakdownReturnKg += Number(r.receivedQty)
    }
  }

  return NextResponse.json({
    vendorPoId: po.id,
    poNumber: po.poNumber,
    status: po.status,
    orderedKg,
    orderedGsm,
    invoiceRatePerKg,
    totalReceivedKg: totalReceivedGrossKg,
    totalUsableReceivedKg,
    outstandingKg,
    accruedReceiptPayableInr,
    receiptBreakdownStockKg,
    receiptBreakdownPenaltyKg,
    receiptBreakdownReturnKg,
    receipts: po.receipts.map((r) => {
      const penaltyRecommendedInr =
        r.qcPenaltyRecommendedInr != null ? Number(r.qcPenaltyRecommendedInr) : null
      const penaltyRate = r.qcInvoiceRatePerKg != null ? Number(r.qcInvoiceRatePerKg) : null
      const penaltyShortfallPct =
        r.qcTechnicalShortfallPct != null ? Number(r.qcTechnicalShortfallPct) : null
      const act = r.qcActualGsm != null ? Number(r.qcActualGsm) : null
      const penKg = r.qtyAcceptedPenalty != null ? Number(r.qtyAcceptedPenalty) : 0
      let penaltyProofLines: string[] | null = null
      if (
        r.qcStatus === 'PASSED_WITH_PENALTY' &&
        orderedGsm != null &&
        act != null &&
        penaltyRate != null &&
        penaltyShortfallPct != null &&
        penaltyRecommendedInr != null
      ) {
        penaltyProofLines = formatQualityPenaltyProofLines({
          orderedGsm,
          actualGsm: act,
          invoiceRatePerKg: penaltyRate,
          receivedQtyKg: Number(r.receivedQty),
          penaltyQtyKg: penKg > 0 ? penKg : undefined,
          shortfallPct: penaltyShortfallPct,
          valueLossInr: penaltyRecommendedInr,
        })
      }
      return {
        id: r.id,
        receiptDate: r.receiptDate.toISOString(),
        receivedQty: Number(r.receivedQty),
        vehicleNumber: r.vehicleNumber,
        scaleSlipId: r.scaleSlipId,
        receivedByUserId: r.receivedByUserId,
        receivedByName: r.receivedByName,
        createdAt: r.createdAt.toISOString(),
        qcStatus: r.qcStatus,
        qcComplete: isGrnQcComplete(r),
        qtyAcceptedStandard: r.qtyAcceptedStandard != null ? Number(r.qtyAcceptedStandard) : null,
        qtyAcceptedPenalty: r.qtyAcceptedPenalty != null ? Number(r.qtyAcceptedPenalty) : null,
        qtyRejected: r.qtyRejected != null ? Number(r.qtyRejected) : null,
        rejectionReason: r.rejectionReason,
        rejectionRemarks: r.rejectionRemarks,
        returnGatePassGeneratedAt: r.returnGatePassGeneratedAt?.toISOString() ?? null,
        qcAccruedPayableInr: r.qcAccruedPayableInr != null ? Number(r.qcAccruedPayableInr) : null,
        qcDetails:
          r.qcPerformedAt != null
            ? {
                actualGsm: r.qcActualGsm != null ? Number(r.qcActualGsm) : null,
                shadeMatch: r.qcShadeMatch,
                surfaceCleanliness: r.qcSurfaceCleanliness,
                qcRemarks: r.qcRemarks,
                qcPerformedByUserId: r.qcPerformedByUserId,
                qcPerformedAt: r.qcPerformedAt.toISOString(),
              }
            : null,
        penaltyRecommendedInr,
        penaltyShortfallPct,
        penaltyInvoiceRatePerKg: penaltyRate,
        penaltyProofLines,
        qualityDebitNote: r.qualityDebitNote,
      }
    }),
  })
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id: vendorPoId } = await context.params

  const parsed = postBodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const po = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id: vendorPoId },
    select: { id: true, poNumber: true, status: true, isShortClosed: true, supplierId: true },
  })
  if (!po) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (po.isShortClosed || po.status === 'closed') {
    return NextResponse.json({ error: 'Cannot add receipts to a closed PO' }, { status: 400 })
  }
  if (!isVendorPoPostDispatchReceiving(po.status)) {
    return NextResponse.json(
      { error: 'Receipts can only be logged after mill dispatch' },
      { status: 400 },
    )
  }

  const receiptDate = new Date(parsed.data.receiptDate)
  if (Number.isNaN(receiptDate.getTime())) {
    return NextResponse.json({ error: 'Invalid receipt date' }, { status: 400 })
  }

  const operatorName = (user!.name?.trim() || INDUSTRIAL_DEFAULT_OPERATOR).trim()

  const receipt = await db.$transaction(async (tx) => {
    // Extended tx: receipt + aggregate sync + inventory quarantine fill +
    // PaperWarehouse mint per matched line. Bump beyond Prisma's 5s default.
    const row = await tx.vendorMaterialReceipt.create({
      data: {
        vendorPoId,
        receiptDate,
        receivedQty: parsed.data.receivedQty,
        vehicleNumber: parsed.data.vehicleNumber.trim().toUpperCase(),
        scaleSlipId: parsed.data.scaleSlipId.trim(),
        receivedByUserId: user!.id,
        receivedByName: operatorName,
      },
    })
    await syncVendorPoReceiptAggregate(tx, vendorPoId)

    const receiptKg = Number(row.receivedQty)
    if (receiptKg > 0) {
      const lines = await tx.vendorMaterialPurchaseOrderLine.findMany({
        where: { vendorPoId },
        select: {
          boardGrade: true,
          gsm: true,
          totalWeightKg: true,
          ratePerKg: true,
          grainDirection: true,
        },
      })
      const totalLineKg = lines.reduce((s, l) => s + Number(l.totalWeightKg), 0)

      for (const line of lines) {
        const share =
          totalLineKg > 0
            ? Number(line.totalWeightKg) / totalLineKg
            : lines.length > 0
              ? 1 / lines.length
              : 0
        const lineKg = Number((receiptKg * share).toFixed(3))
        if (lineKg <= 0) continue

        const invRow = await tx.inventory.findFirst({
          where: { boardType: line.boardGrade, gsm: line.gsm },
          select: {
            id: true,
            unit: true,
            sheetLength: true,
            sheetWidth: true,
            gsm: true,
            boardType: true,
            boardClassification: true,
            storageLocation: true,
          },
        })
        if (!invRow) continue

        let quarantineDelta = lineKg
        if (invRow.unit === 'sheets' && invRow.sheetLength && invRow.sheetWidth && invRow.gsm) {
          const sheetWeightG =
            (Number(invRow.sheetLength) * Number(invRow.sheetWidth) * invRow.gsm) / 1_000_000
          quarantineDelta = sheetWeightG > 0 ? Math.round((lineKg * 1000) / sheetWeightG) : 0
        }
        if (quarantineDelta <= 0) continue

        await tx.inventory.update({
          where: { id: invRow.id },
          data: { qtyQuarantine: { increment: quarantineDelta } },
        })
        await tx.stockMovement.create({
          data: {
            materialId: invRow.id,
            movementType: 'grn_quarantine',
            qty: quarantineDelta,
            refType: 'vendor_receipt',
            refId: row.id,
            userId: user!.id,
          },
        })

        if (invRow.boardType && invRow.gsm) {
          const sheetSizeLabel =
            invRow.sheetLength != null && invRow.sheetWidth != null
              ? `${Number(invRow.sheetLength)} × ${Number(invRow.sheetWidth)} mm`
              : null
          await tx.paperWarehouse.create({
            data: {
              vendorId: po.supplierId,
              paperType: invRow.boardType,
              boardGrade: invRow.boardClassification ?? null,
              gsm: invRow.gsm,
              qtySheets: quarantineDelta,
              lotNumber: row.scaleSlipId,
              rate: line.ratePerKg != null ? Number(line.ratePerKg) : null,
              coaReference: row.id,
              receiptDate: row.receiptDate,
              location: invRow.storageLocation ?? null,
              sheetSizeLabel,
              grainDirection: line.grainDirection,
              supplierGsm: line.gsm,
              status: 'quarantine',
            },
          })
        }
      }
    }

    return row
  }, { maxWait: 5000, timeout: 15000 })

  const poAfter = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id: vendorPoId },
    include: { lines: { select: { totalWeightKg: true, gsm: true } } },
  })
  const orderedKg = poAfter ? sumOrderedKgFromLines(poAfter.lines) : 0
  const totalReceivedKg = poAfter ? Number(poAfter.totalReceivedKg) : 0
  const totalUsableReceivedKg = poAfter ? Number(poAfter.totalUsableReceivedKg) : 0
  const outstandingKg = Math.max(0, orderedKg - totalUsableReceivedKg)
  const orderedGsm = poAfter ? orderedGsmFromVendorLines(poAfter.lines) : null

  const auditMessage = `GRN logged: ${Number(receipt.receivedQty).toFixed(3)} kg · vehicle ${receipt.vehicleNumber} · slip ${receipt.scaleSlipId} · by ${operatorName}`

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'vendor_material_receipts',
    recordId: receipt.id,
    newValue: {
      vendorPoId,
      poNumber: po.poNumber,
      receiptDate: receiptDate.toISOString(),
      receivedQty: Number(receipt.receivedQty),
      vehicleNumber: receipt.vehicleNumber,
      scaleSlipId: receipt.scaleSlipId,
      receivedByName: operatorName,
      vendorPoStatusAfter: poAfter?.status,
      message: auditMessage,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'vendor_material_grn_receipt',
    module: 'VendorMaterialPO',
    recordId: vendorPoId,
    operatorLabel: operatorName,
    payload: {
      receiptId: receipt.id,
      poNumber: po.poNumber,
      receivedQty: Number(receipt.receivedQty),
      vehicleNumber: receipt.vehicleNumber,
      scaleSlipId: receipt.scaleSlipId,
      receiptDateIso: receiptDate.toISOString(),
      totalReceivedKg,
      totalUsableReceivedKg,
      orderedKg,
      status: poAfter?.status,
      auditMessage,
    },
  })

  return NextResponse.json({
    ok: true,
    receipt: {
      id: receipt.id,
      receiptDate: receipt.receiptDate.toISOString(),
      receivedQty: Number(receipt.receivedQty),
      vehicleNumber: receipt.vehicleNumber,
      scaleSlipId: receipt.scaleSlipId,
      receivedByName: receipt.receivedByName,
      createdAt: receipt.createdAt.toISOString(),
      qcStatus: null,
      qcDetails: null,
    },
    orderedKg,
    orderedGsm,
    totalReceivedKg,
    totalUsableReceivedKg,
    outstandingKg,
    status: poAfter?.status,
    message: auditMessage,
  })
}
