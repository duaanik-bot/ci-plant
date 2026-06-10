import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { n, prNumber, priorityFromTrigger, sourceFromTrigger, ymd } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  action: z.enum(['edit', 'submit', 'approve', 'reject']).optional(),
  status: z.enum(['draft', 'pending', 'approved', 'rejected', 'converted_to_po']).optional(),
  requiredQty: z.coerce.number().positive().optional(),
  requiredDate: z.string().optional(),
  priority: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(),
  remarks: z.string().nullable().optional(),
  rejectionReason: z.string().trim().optional(),
})

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params

  const row = await db.purchaseRequisition.findUnique({
    where: { id },
    include: {
      material: true,
      vendorPurchaseOrders: { select: { id: true, poNumber: true, status: true } },
      poLinks: { include: { vendorPo: { select: { id: true, poNumber: true, status: true } } } },
    },
  })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const timeline = [
    { label: 'Draft created', at: row.createdAt.toISOString(), by: row.raisedBy ?? 'System' },
    row.status !== 'draft' ? { label: row.status, at: row.approvedAt?.toISOString() ?? row.raisedAt.toISOString(), by: row.approvedBy ?? '-' } : null,
    ...row.poLinks.map((l) => ({ label: `Linked to ${l.vendorPo.poNumber}`, at: l.createdAt.toISOString(), by: 'Procurement' })),
  ].filter(Boolean)
  const linkedQty = row.poLinks.reduce((s, l) => s + n(l.allocatedQty), 0)
  const lineStatus = row.status === 'converted_to_po'
    ? 'Converted'
    : row.status === 'rejected'
      ? 'Cancelled'
      : linkedQty > 0
        ? 'Partially Converted'
        : 'Open'

  return NextResponse.json({
    id: row.id,
    prNo: prNumber(row.id, row.raisedAt),
    date: ymd(row.raisedAt),
    source: sourceFromTrigger(row.triggerReason),
    requestedBy: row.raisedBy ?? 'System',
    department: row.triggerReason,
    requiredDate: ymd(row.requiredByDate),
    priority: priorityFromTrigger(row.triggerReason),
    status: row.status,
    remarks: row.remarks,
    sourceReference: {
      planningId: row.sourcePlanningId,
      jobCardId: row.sourceJobCardId,
      shortageId: row.shortageId,
      customerPoNumber: row.customerPoNumber,
      productName: row.productName,
    },
    lineItems: [
      {
        item: row.material.materialCode,
        itemId: row.materialId,
        description: row.material.description,
        itemCategory: row.material.category,
        currentStock: n(row.material.qtyAvailable) + n(row.material.qtyReserved),
        reservedStock: n(row.material.qtyReserved),
        availableStock: n(row.material.qtyAvailable),
        requiredQty: n(row.qtyRequired),
        convertedQty: linkedQty,
        balanceQty: Math.max(0, n(row.qtyRequired) - linkedQty),
        uom: row.material.unit,
        lineStatus,
        remarks: row.remarks,
      },
    ],
    purchaseOrders: [...row.vendorPurchaseOrders, ...row.poLinks.map((l) => l.vendorPo)],
    timeline,
  })
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const existing = await db.purchaseRequisition.findUnique({ where: { id }, include: { material: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const action = parsed.data.action
  let status = parsed.data.status ?? existing.status
  if (action === 'submit') {
    if (existing.status !== 'draft') return NextResponse.json({ error: 'Only draft PRs can be submitted for approval' }, { status: 409 })
    status = 'pending'
  }
  if (action === 'approve') {
    if (existing.status !== 'pending') return NextResponse.json({ error: 'Only pending PRs can be approved' }, { status: 409 })
    status = 'approved'
  }
  if (action === 'reject') {
    if (!parsed.data.rejectionReason && !parsed.data.remarks) return NextResponse.json({ error: 'Reject reason is required' }, { status: 400 })
    if (!['pending', 'approved'].includes(existing.status)) return NextResponse.json({ error: 'Only pending or approved PRs can be rejected' }, { status: 409 })
    status = 'rejected'
  }
  if (action === 'edit' && existing.status !== 'draft') {
    return NextResponse.json({ error: 'Only draft PRs can be edited' }, { status: 409 })
  }
  const nextRemarks = parsed.data.rejectionReason
    ? [existing.remarks, `Rejected: ${parsed.data.rejectionReason}`].filter(Boolean).join('\n')
    : parsed.data.remarks !== undefined
      ? parsed.data.remarks
      : existing.remarks
  const triggerReason = parsed.data.priority
    ? `${sourceFromTrigger(existing.triggerReason)} ${parsed.data.priority}`
    : existing.triggerReason
  const updated = await db.purchaseRequisition.update({
    where: { id },
    data: {
      status,
      ...(parsed.data.requiredQty ? { qtyRequired: parsed.data.requiredQty, estimatedValue: parsed.data.requiredQty * n(existing.material.weightedAvgCost) } : {}),
      ...(parsed.data.requiredDate !== undefined ? { requiredByDate: parsed.data.requiredDate ? new Date(parsed.data.requiredDate) : null } : {}),
      triggerReason,
      remarks: nextRemarks,
      ...(status === 'approved' ? { approvedAt: new Date(), approvedBy: user?.name || user?.email || user?.id } : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_requisitions',
    recordId: id,
    oldValue: { status: existing.status, remarks: existing.remarks },
    newValue: { event: action === 'submit' ? 'PR_SUBMITTED' : action === 'approve' ? 'PR_APPROVED' : action === 'reject' ? 'PR_REJECTED' : 'PR_UPDATED', status: updated.status, remarks: updated.remarks },
  })

  return NextResponse.json({ ok: true })
}
