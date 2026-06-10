import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { n, poOperationalStatus, ymd } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  action: z.enum(['edit', 'mark_sent', 'close', 'cancel']).optional(),
  status: z.enum(['draft', 'confirmed', 'sent', 'partial_received', 'received', 'closed', 'cancelled']).optional(),
  expectedDeliveryDate: z.string().optional(),
  expectedDeliveryFollowUpDate: z.string().optional(),
  paymentTerms: z.string().optional(),
  deliveryTerms: z.string().optional(),
  amendmentNote: z.string().optional(),
  supplierConfirmationStatus: z.string().optional(),
  deliveryDelayFlag: z.boolean().optional(),
  partialCloseLineIds: z.array(z.string()).optional(),
  remarks: z.string().nullable().optional(),
  reason: z.string().optional(),
})

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const po = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id },
    include: {
      supplier: true,
      lines: true,
      receipts: { orderBy: { receiptDate: 'desc' } },
      purchaseRequisition: { include: { material: { select: { materialCode: true, description: true } } } },
      requisitionLinks: { include: { pr: { include: { material: { select: { materialCode: true, description: true } } } } } },
    },
  })
  if (!po) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const orderedKg = po.lines.reduce((s, line) => s + n(line.totalWeightKg), 0)
  const value = po.lines.reduce((s, line) => s + n(line.totalWeightKg) * n(line.ratePerKg), 0)
  return NextResponse.json({
    id: po.id,
    poNo: po.poNumber,
    supplier: po.supplier,
    date: ymd(po.orderDate),
    expectedDelivery: ymd(po.requiredDeliveryDate),
    paymentTerms: po.paymentTerms,
    deliveryTerms: po.transportTerms,
    buyer: po.signatoryName,
    remarks: po.remarks,
    supplierConfirmationStatus: po.logisticsStatus === 'supplier_confirmed' ? 'confirmed' : po.logisticsStatus ?? 'pending',
    deliveryDelayFlag: Boolean(po.requiredDeliveryDate && po.requiredDeliveryDate < new Date() && !['received', 'closed', 'cancelled'].includes(po.status)),
    expectedDeliveryFollowUpDate: ymd(po.logisticsUpdatedAt),
    status: poOperationalStatus(po.status),
    orderedKg,
    receivedKg: n(po.totalUsableReceivedKg),
    value,
    sourcePr: po.purchaseRequisition
      ? {
          id: po.purchaseRequisition.id,
          materialCode: po.purchaseRequisition.material.materialCode,
          description: po.purchaseRequisition.material.description,
        }
      : null,
    lineItems: po.lines.map((line) => {
      const lineShare = orderedKg > 0 ? n(line.totalWeightKg) / orderedKg : 0
      const receivedQty = n(po.totalUsableReceivedKg) * lineShare
      const balanceQty = Math.max(0, n(line.totalWeightKg) - receivedQty)
      return {
      id: line.id,
      item: line.boardGrade,
      description: `${line.boardGrade}${line.gsm ? ` ${line.gsm} gsm` : ''}`,
      quantity: n(line.totalWeightKg),
      uom: 'kg',
      rate: line.ratePerKg == null ? 0 : n(line.ratePerKg),
      tax: 0,
      amount: n(line.totalWeightKg) * n(line.ratePerKg),
      expectedDelivery: ymd(po.requiredDeliveryDate),
      receivedQty,
      balanceQty,
      cancelledQty: po.status === 'closed' || po.status === 'cancelled' ? balanceQty : 0,
      receivingPct: n(line.totalWeightKg) > 0 ? Math.min(100, (receivedQty / n(line.totalWeightKg)) * 100) : 0,
    }}),
    receipts: po.receipts.map((r) => ({
      id: r.id,
      grnNo: `GRN-${r.receiptDate.getFullYear()}-${r.id.slice(0, 8).toUpperCase()}`,
      receiptDate: ymd(r.receiptDate),
      receivedQty: n(r.receivedQty),
      qcStatus: r.qcStatus ?? 'QC_PENDING',
    })),
    linkedPrs: po.requisitionLinks.map((l) => ({ id: l.pr.id, materialCode: l.pr.material.materialCode, description: l.pr.material.description, allocatedQty: n(l.allocatedQty), status: l.pr.status })),
  })
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  const existing = await db.vendorMaterialPurchaseOrder.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let status = parsed.data.status
  if (parsed.data.action === 'mark_sent') status = 'sent'
  if (parsed.data.action === 'close') status = 'closed'
  if (parsed.data.action === 'cancel') status = 'cancelled'
  if (parsed.data.action === 'edit' && existing.status !== 'draft') {
    return NextResponse.json({ error: 'Only draft POs can be edited' }, { status: 409 })
  }
  if ((parsed.data.action === 'cancel' || parsed.data.status === 'cancelled') && !parsed.data.reason && !parsed.data.remarks) {
    return NextResponse.json({ error: 'Cancel reason is required' }, { status: 400 })
  }
  if (parsed.data.action === 'mark_sent' && existing.status !== 'draft') {
    return NextResponse.json({ error: 'Only draft POs can be marked sent' }, { status: 409 })
  }
  const updated = await db.vendorMaterialPurchaseOrder.update({
    where: { id },
    data: {
      ...(status ? { status } : {}),
      ...(parsed.data.expectedDeliveryDate !== undefined ? { requiredDeliveryDate: parsed.data.expectedDeliveryDate ? new Date(parsed.data.expectedDeliveryDate) : null } : {}),
      ...(parsed.data.paymentTerms !== undefined ? { paymentTerms: parsed.data.paymentTerms } : {}),
      ...(parsed.data.deliveryTerms !== undefined ? { transportTerms: parsed.data.deliveryTerms } : {}),
      ...(parsed.data.remarks !== undefined || parsed.data.reason || parsed.data.amendmentNote || parsed.data.partialCloseLineIds?.length
        ? {
            remarks: [
              parsed.data.remarks ?? existing.remarks,
              parsed.data.amendmentNote ? `Amendment: ${parsed.data.amendmentNote}` : null,
              parsed.data.partialCloseLineIds?.length ? `Partial close lines: ${parsed.data.partialCloseLineIds.join(', ')}` : null,
              parsed.data.reason ? `Reason: ${parsed.data.reason}` : null,
            ].filter(Boolean).join('\n'),
          }
        : {}),
      ...(parsed.data.expectedDeliveryFollowUpDate ? { logisticsUpdatedAt: new Date(parsed.data.expectedDeliveryFollowUpDate) } : {}),
      ...(parsed.data.supplierConfirmationStatus ? { logisticsStatus: parsed.data.supplierConfirmationStatus } : {}),
      ...(parsed.data.deliveryDelayFlag ? { procurementShortageFlag: 'DELIVERY_DELAY' } : {}),
      ...(status === 'closed' ? { isShortClosed: true, shortCloseReason: parsed.data.reason || 'Closed from Procurement', shortClosedAt: new Date(), shortClosedByUserId: user?.id, shortClosedByName: user?.name || user?.email || 'Procurement' } : {}),
      ...(status === 'cancelled' ? { isShortClosed: true, shortCloseReason: parsed.data.reason || 'Cancelled from Procurement', shortClosedAt: new Date(), shortClosedByUserId: user?.id, shortClosedByName: user?.name || user?.email || 'Procurement' } : {}),
    },
  })
  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'vendor_material_purchase_orders',
    recordId: id,
    oldValue: { status: existing.status, remarks: existing.remarks },
    newValue: { event: status === 'sent' ? 'PO_SENT' : status === 'closed' ? 'PO_CLOSED' : status === 'cancelled' ? 'PO_CANCELLED' : 'PO_UPDATED', status: updated.status, remarks: updated.remarks },
  })
  return NextResponse.json({ ok: true })
}
