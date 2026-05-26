import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'
import { createAuditLog } from '@/lib/audit'
import { consolidatePrs, type ConsolidatablePr } from '@/lib/pr-consolidation'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  prIds: z.array(z.string().uuid()).min(1),
  vendorId: z.string().uuid(),
  deliveryDate: z.string().datetime().optional(),
  paymentTerms: z.string().max(200).optional(),
  transportTerms: z.string().max(200).optional(),
  remarks: z.string().max(2000).optional(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const { prIds, vendorId, deliveryDate, paymentTerms, transportTerms, remarks } = parsed.data

  const prs = await db.purchaseRequisition.findMany({
    where: { id: { in: prIds } },
    include: { material: { select: { materialCode: true, storageLocation: true, category: true } } },
  })
  if (prs.length !== prIds.length) {
    return NextResponse.json({ error: 'One or more PRs not found' }, { status: 404 })
  }
  const notOrderable = prs.filter((p) => p.status !== 'approved' && p.status !== 'ordered')
  if (notOrderable.length > 0) {
    return NextResponse.json(
      { error: `PRs must be Approved or Ordered (awaiting PO) to generate a PO: ${notOrderable.map((p) => p.id).join(', ')}` },
      { status: 400 },
    )
  }
  const missingSpec = prs.filter((p) => !p.boardType || p.gsm == null)
  if (missingSpec.length > 0) {
    return NextResponse.json(
      { error: `PRs missing boardType/gsm cannot be ordered: ${missingSpec.map((p) => p.material.materialCode).join(', ')}` },
      { status: 400 },
    )
  }

  const consolidatable: ConsolidatablePr[] = prs.map((p) => ({
    id: p.id,
    materialId: p.materialId,
    materialCode: p.material.materialCode,
    boardType: p.boardType,
    gsm: p.gsm,
    sizeLabel: p.sizeLabel,
    warehouse: p.material.storageLocation ?? null,
    procurementCategory: p.material.category ?? null,
    qty: Number(p.qtyRequired),
    supplierId: p.supplierId,
    requiredByDate: p.requiredByDate?.toISOString() ?? null,
  }))
  const groups = consolidatePrs(consolidatable)

  const result = await db.$transaction(async (tx) => {
    const now = new Date()
    const yyyymmdd =
      `${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}`
    const prefix = `PO-${yyyymmdd}-`
    const sameDayCount = await tx.vendorMaterialPurchaseOrder.count({ where: { poNumber: { startsWith: prefix } } })
    const poNumber = `${prefix}${String(sameDayCount + 1).padStart(3, '0')}`

    const po = await tx.vendorMaterialPurchaseOrder.create({
      data: {
        poNumber,
        supplierId: vendorId,
        purchaseRequisitionId: prs[0]!.id,
        requiredDeliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
        paymentTerms: paymentTerms ?? undefined,
        transportTerms: transportTerms ?? undefined,
        remarks: remarks ?? undefined,
        createdBy: user!.id,
        lines: {
          create: groups.map((g) => ({
            boardGrade: g.boardType ?? 'Unknown',
            gsm: g.gsm ?? 0,
            totalSheets: 0,
            totalWeightKg: g.totalQty,
            linkedPoLineIds: [],
          })),
        },
      },
    })

    await tx.vendorPoRequisitionLink.createMany({
      data: groups.flatMap((g) =>
        g.members.map((m) => ({ vendorPoId: po.id, purchaseRequisitionId: m.prId, allocatedQty: m.qty })),
      ),
    })

    await tx.purchaseRequisition.updateMany({
      where: { id: { in: prIds } },
      data: {
        status: 'converted_to_po',
        poReference: po.id,
        supplierId: vendorId,
        ...(deliveryDate ? { expectedDelivery: new Date(deliveryDate) } : {}),
      },
    })

    return po
  })

  for (const prId of prIds) {
    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'purchase_requisitions',
      recordId: prId,
      oldValue: { status: 'approved_or_ordered' },
      newValue: { status: 'converted_to_po', vendorPoId: result.id, poNumber: result.poNumber },
    })
  }

  return NextResponse.json({
    success: true,
    purchaseOrderId: result.id,
    poNumber: result.poNumber,
    lineCount: groups.length,
    linkedPrCount: prIds.length,
  })
}
