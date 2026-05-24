import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { z } from 'zod'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  expectedDelivery: z.string().datetime().optional(),
  supplierId: z.string().uuid().optional(),
})

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole(
    'admin',
    'plant_head',
    'accounts'
  )
  if (error) return error

  const { id } = await context.params
  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const pr = await db.purchaseRequisition.findUnique({ where: { id } })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })
  if (pr.status !== 'approved') {
    return NextResponse.json(
      { error: 'Only approved PRs can be converted to PO' },
      { status: 400 }
    )
  }

  const supplierId = pr.supplierId ?? parsed.data.supplierId
  if (!supplierId) {
    return NextResponse.json(
      { error: 'PR has no supplier assigned — pass supplierId in body or assign on the PR before converting' },
      { status: 400 }
    )
  }

  if (!pr.boardType || pr.gsm == null) {
    return NextResponse.json(
      { error: 'PR is missing boardType or gsm — cannot create PO line' },
      { status: 400 }
    )
  }

  const expectedDelivery = parsed.data.expectedDelivery
    ? new Date(parsed.data.expectedDelivery)
    : undefined

  const result = await db.$transaction(async (tx) => {
    const now = new Date()
    const yyyymmdd =
      `${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}`
    const prefix = `PO-${yyyymmdd}-`
    const sameDayCount = await tx.vendorMaterialPurchaseOrder.count({
      where: { poNumber: { startsWith: prefix } },
    })
    const poNumber = `${prefix}${String(sameDayCount + 1).padStart(3, '0')}`

    const newPo = await tx.vendorMaterialPurchaseOrder.create({
      data: {
        poNumber,
        supplierId,
        purchaseRequisitionId: pr.id,
        requiredDeliveryDate: expectedDelivery,
        createdBy: user!.id,
        lines: {
          create: [
            {
              boardGrade: pr.boardType!,
              gsm: pr.gsm!,
              totalSheets: 0,
              totalWeightKg: pr.qtyRequired,
              linkedPoLineIds: [],
            },
          ],
        },
      },
    })

    // Write join-table row so the monitoring view can find this PO via the link.
    await tx.vendorPoRequisitionLink.create({
      data: {
        vendorPoId: newPo.id,
        purchaseRequisitionId: pr.id,
        allocatedQty: pr.qtyRequired,
      },
    })

    const updatedPr = await tx.purchaseRequisition.update({
      where: { id: pr.id },
      data: {
        status: 'converted_to_po',
        poReference: newPo.id,
        expectedDelivery,
      },
    })

    return { newPo, updatedPr }
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'purchase_requisitions',
    recordId: result.updatedPr.id,
    oldValue: { status: pr.status, poReference: pr.poReference },
    newValue: {
      status: result.updatedPr.status,
      poReference: result.newPo.id,
      vendorPoNumber: result.newPo.poNumber,
    },
  })

  return NextResponse.json({
    success: true,
    message: 'Converted to vendor PO.',
    purchaseOrderId: result.newPo.id,
    poNumber: result.newPo.poNumber,
  })
}
