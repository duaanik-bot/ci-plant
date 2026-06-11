import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'
import { grnNumber, grnQcLabel, n, ymd } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

function boardAliases(board: string): string[] {
  const canonical = normalizeBoardTypeForStorage(board) ?? board
  const legacy = canonical === 'FBB' ? 'Yellow' : canonical === 'Saffire' ? 'White' : canonical
  return Array.from(new Set([canonical, board, legacy].filter(Boolean)))
}

const patchSchema = z.object({
  action: z.enum(['edit_draft', 'qc_update', 'post_to_stock', 'cancel']).optional(),
  receivingQty: z.coerce.number().positive().optional(),
  acceptedQty: z.coerce.number().nonnegative().optional(),
  rejectedQty: z.coerce.number().nonnegative().optional(),
  rejectionReason: z.string().optional(),
  remarks: z.string().optional(),
  warehouse: z.string().optional(),
  binLocation: z.string().optional(),
})

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const r = await db.vendorMaterialReceipt.findUnique({
    where: { id },
    include: {
      vendorPo: { include: { supplier: true, lines: true } },
    },
  })
  if (!r) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const orderedQty = r.vendorPo.lines.reduce((s, line) => s + n(line.totalWeightKg), 0)
  const acceptedQty = r.qtyAcceptedStandard != null || r.qtyAcceptedPenalty != null ? n(r.qtyAcceptedStandard) + n(r.qtyAcceptedPenalty) : 0
  const rejectedQty = n(r.qtyRejected)
  const qcStatus = grnQcLabel(acceptedQty, rejectedQty, n(r.receivedQty), r.qcStatus)
  return NextResponse.json({
    id: r.id,
    grnNo: grnNumber(r.id, r.receiptDate),
    poId: r.vendorPoId,
    poNo: r.vendorPo.poNumber,
    supplier: r.vendorPo.supplier,
    supplierInvoiceNumber: r.scaleSlipId,
    vehicleNumber: r.vehicleNumber,
    receivedDate: ymd(r.receiptDate),
    receivedBy: r.receivedByName,
    remarks: r.qcRemarks,
    status: qcStatus,
    postedAt: r.qcPerformedAt?.toISOString() ?? null,
    postedBy: r.qcPerformedByUserId,
    lineItems: r.vendorPo.lines.map((line) => ({
      item: line.boardGrade,
      orderedQty: n(line.totalWeightKg),
      previouslyReceivedQty: n(r.vendorPo.totalUsableReceivedKg),
      balanceQty: Math.max(0, orderedQty - n(r.vendorPo.totalUsableReceivedKg)),
      receivingQty: n(r.receivedQty),
      acceptedQty,
      rejectedQty,
      uom: 'kg',
      qcStatus,
      binRackLocation: '',
      rejectionReason: r.rejectionReason,
      remarks: r.qcRemarks,
    })),
  })
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  const data = parsed.data

  const receipt = await db.vendorMaterialReceipt.findUnique({
    where: { id },
    include: { vendorPo: { include: { lines: true } } },
  })
  if (!receipt) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (receipt.qcStatus === 'POSTED_TO_STOCK') return NextResponse.json({ error: 'Cannot post GRN because it is already posted.' }, { status: 409 })

  if (data.action === 'cancel') {
    await db.vendorMaterialReceipt.update({ where: { id }, data: { qcStatus: 'CANCELLED', qcRemarks: data.remarks ?? receipt.qcRemarks } })
    await createAuditLog({ userId: user!.id, action: 'UPDATE', tableName: 'vendor_material_receipts', recordId: id, oldValue: { qcStatus: receipt.qcStatus }, newValue: { event: 'GRN_CANCELLED', qcStatus: 'CANCELLED', remarks: data.remarks ?? null } })
    return NextResponse.json({ ok: true })
  }

  if (data.action === 'edit_draft' || data.action === 'qc_update') {
    if (receipt.qcStatus !== 'DRAFT' && data.action === 'edit_draft') return NextResponse.json({ error: 'Only draft GRNs can be edited' }, { status: 409 })
    const receivingQty = data.receivingQty ?? n(receipt.receivedQty)
    const acceptedQty = data.acceptedQty ?? n(receipt.qtyAcceptedStandard) + n(receipt.qtyAcceptedPenalty)
    const rejectedQty = data.rejectedQty ?? n(receipt.qtyRejected)
    if (acceptedQty + rejectedQty > receivingQty) return NextResponse.json({ error: 'Accepted + rejected quantity cannot exceed receiving quantity.' }, { status: 400 })
    const status = data.action === 'qc_update' ? grnQcLabel(acceptedQty, rejectedQty, receivingQty, 'QC_PENDING') : 'DRAFT'
    await db.vendorMaterialReceipt.update({
      where: { id },
      data: {
        receivedQty: receivingQty,
        qtyAcceptedStandard: acceptedQty,
        qtyAcceptedPenalty: 0,
        qtyRejected: rejectedQty,
        rejectionReason: data.rejectionReason ?? receipt.rejectionReason,
        qcStatus: status,
        qcRemarks: [data.remarks ?? receipt.qcRemarks, data.warehouse ? `Warehouse: ${data.warehouse}` : null, data.binLocation ? `Bin: ${data.binLocation}` : null].filter(Boolean).join(' | ') || null,
      },
    })
    await createAuditLog({ userId: user!.id, action: 'UPDATE', tableName: 'vendor_material_receipts', recordId: id, oldValue: { qcStatus: receipt.qcStatus }, newValue: { event: data.action === 'qc_update' ? 'GRN_QC_UPDATED' : 'GRN_UPDATED', qcStatus: status, acceptedQty, rejectedQty } })
    return NextResponse.json({ ok: true })
  }

  if (data.action !== 'post_to_stock') return NextResponse.json({ error: 'No action supplied' }, { status: 400 })

  const existingAcceptedQty = n(receipt.qtyAcceptedStandard) + n(receipt.qtyAcceptedPenalty)
  const acceptedQty = data.acceptedQty ?? (existingAcceptedQty > 0 ? existingAcceptedQty : n(receipt.receivedQty))
  const rejectedQty = data.rejectedQty ?? Math.max(0, n(receipt.receivedQty) - acceptedQty)
  if (acceptedQty + rejectedQty > n(receipt.receivedQty)) return NextResponse.json({ error: 'Accepted + rejected quantity cannot exceed receiving quantity.' }, { status: 400 })
  if (acceptedQty <= 0) return NextResponse.json({ error: 'Accepted quantity must be positive' }, { status: 400 })
  const totalLineQtyForPayable = receipt.vendorPo.lines.reduce((s, line) => s + n(line.totalWeightKg), 0)
  const payableAccrual = receipt.vendorPo.lines.reduce(
    (s, line) => s + n(line.ratePerKg) * acceptedQty * (totalLineQtyForPayable > 0 ? n(line.totalWeightKg) / totalLineQtyForPayable : 0),
    0,
  )

  await db.$transaction(async (tx) => {
    const totalLineQty = receipt.vendorPo.lines.reduce((s, line) => s + n(line.totalWeightKg), 0)
    for (const line of receipt.vendorPo.lines) {
      const share = totalLineQty > 0 ? n(line.totalWeightKg) / totalLineQty : 1 / Math.max(1, receipt.vendorPo.lines.length)
      const lineAccepted = Number((acceptedQty * share).toFixed(3))
      if (lineAccepted <= 0) continue
      const linked = Array.isArray(line.linkedPoLineIds) ? line.linkedPoLineIds[0] as { materialId?: string } : null
      const material = linked?.materialId
        ? await tx.inventory.findUnique({ where: { id: linked.materialId } })
        : await tx.inventory.findFirst({
            where: {
              gsm: line.gsm,
              OR: boardAliases(line.boardGrade).map((board) => ({ boardType: { equals: board, mode: 'insensitive' as const } })),
            },
          })
      if (!material) continue
      await tx.inventory.update({
        where: { id: material.id },
        data: { qtyAvailable: { increment: lineAccepted } },
      })
      await tx.stockMovement.create({
        data: {
          materialId: material.id,
          movementType: 'procurement_inward',
          qty: lineAccepted,
          refType: 'procurement_grn',
          refId: receipt.id,
          userId: user?.id,
          reservedByName: `GRN ${grnNumber(receipt.id, receipt.receiptDate)} / PO ${receipt.vendorPo.poNumber}`,
        },
      })
    }

    await tx.vendorMaterialReceipt.update({
      where: { id },
      data: {
        qtyAcceptedStandard: acceptedQty,
        qtyAcceptedPenalty: 0,
        qtyRejected: rejectedQty,
        qcStatus: 'POSTED_TO_STOCK',
        qcPerformedByUserId: user?.id,
        qcPerformedAt: new Date(),
        qcAccruedPayableInr: payableAccrual,
        qcRemarks: data.remarks ?? receipt.qcRemarks,
      },
    })
    const nextUsable = n(receipt.vendorPo.totalUsableReceivedKg) + acceptedQty
    const ordered = receipt.vendorPo.lines.reduce((s, line) => s + n(line.totalWeightKg), 0)
    await tx.vendorMaterialPurchaseOrder.update({
      where: { id: receipt.vendorPoId },
      data: {
        totalReceivedKg: { increment: n(receipt.receivedQty) },
        totalUsableReceivedKg: { increment: acceptedQty },
        status: nextUsable >= ordered ? 'received' : 'partial_received',
        accruedReceiptPayableInr: {
          increment: payableAccrual,
        },
      },
    })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'vendor_material_receipts',
    recordId: id,
    oldValue: { qcStatus: receipt.qcStatus },
    newValue: { event: 'GRN_POSTED_TO_STOCK', qcStatus: 'POSTED_TO_STOCK', acceptedQty, rejectedQty, payableReference: `PAYABLE-${receipt.vendorPo.poNumber}`, payableAccrual },
  })
  return NextResponse.json({ ok: true })
}
