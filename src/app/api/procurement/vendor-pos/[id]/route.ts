import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { PROCUREMENT_DEFAULT_SIGNATORY } from '@/lib/procurement-mrp-service'
import { linkedMaterialRefs } from '@/lib/material-display'

export const dynamic = 'force-dynamic'

const putSchema = z.object({
  status: z.enum(['draft', 'confirmed', 'cancelled']).optional(),
  supplierId: z.string().uuid().optional(),
  signatoryName: z.string().min(1).max(120).optional(),
  remarks: z.string().nullable().optional(),
  paymentTerms: z.string().max(200).nullable().optional(),
  transportTerms: z.string().max(200).nullable().optional(),
  requiredDeliveryDate: z.string().nullable().optional(),
  lineUpdates: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        ratePerKg: z.number().nonnegative().nullable().optional(),
        totalWeightKg: z.number().positive().optional(),
      }),
    )
    .optional(),
})

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params

  const row = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id },
    include: {
      supplier: true,
      lines: { orderBy: { boardGrade: 'asc' } },
      receipts: { orderBy: { receiptDate: 'desc' } },
      requisitionLinks: {
        include: {
          pr: {
            include: {
              material: { select: { id: true, materialCode: true } },
            },
          },
        },
      },
    },
  })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const materialIds = Array.from(
    new Set([
      row.materialId,
      ...row.requisitionLinks.map((link) => link.pr.materialId),
      ...row.lines.flatMap((line) => linkedMaterialRefs(line.linkedPoLineIds).map((ref) => ref.materialId)),
    ].filter((value): value is string => !!value)),
  )
  const [reservations, auditLog] = await Promise.all([
    materialIds.length
      ? db.materialReservation.findMany({
          where: { materialId: { in: materialIds } },
          include: {
            material: { select: { id: true, materialCode: true } },
            jobCard: { select: { id: true, jobCardNumber: true, status: true, customer: { select: { name: true } } } },
          },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        })
      : [],
    db.auditLog.findMany({
      where: { tableName: 'vendor_material_purchase_orders', recordId: id },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { timestamp: 'desc' },
      take: 50,
    }),
  ])

  return NextResponse.json({
    ...row,
    lines: row.lines.map((line) => ({
      ...line,
      totalWeightKg: Number(line.totalWeightKg),
      ratePerKg: line.ratePerKg == null ? null : Number(line.ratePerKg),
      linkedMaterialRefs: linkedMaterialRefs(line.linkedPoLineIds),
    })),
    totalReceivedKg: Number(row.totalReceivedKg),
    totalUsableReceivedKg: Number(row.totalUsableReceivedKg),
    receipts: row.receipts.map((receipt) => ({
      ...receipt,
      receivedQty: Number(receipt.receivedQty),
      qtyAcceptedStandard: receipt.qtyAcceptedStandard == null ? null : Number(receipt.qtyAcceptedStandard),
      qtyAcceptedPenalty: receipt.qtyAcceptedPenalty == null ? null : Number(receipt.qtyAcceptedPenalty),
      qtyRejected: receipt.qtyRejected == null ? null : Number(receipt.qtyRejected),
    })),
    reservations: reservations.map((reservation) => ({
      id: reservation.id,
      materialId: reservation.materialId,
      materialCode: reservation.material.materialCode,
      jobCardId: reservation.jobCardId,
      jobCardNumber: reservation.jobCard.jobCardNumber,
      customerName: reservation.jobCard.customer.name,
      jobStatus: reservation.jobCard.status,
      requiredSheets: Number(reservation.requiredSheets),
      reservedSheets: Number(reservation.reservedSheets),
      shortageSheets: Number(reservation.shortageSheets),
      status: reservation.status,
      isReleased: reservation.isReleased,
      updatedAt: reservation.updatedAt.toISOString(),
    })),
    auditLog: auditLog.map((entry) => ({
      id: String(entry.id),
      action: entry.action,
      userName: entry.user?.name ?? entry.user?.email ?? 'System',
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      timestamp: entry.timestamp.toISOString(),
    })),
  })
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params

  const existing = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id },
    include: { lines: true },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = putSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const data = parsed.data

  if (data.status === 'draft' && Number(existing.totalReceivedKg) > 0) {
    return NextResponse.json({ error: 'Cannot reopen a PO after GRN receipt has started.' }, { status: 409 })
  }

  if (data.supplierId) {
    const supplier = await db.supplier.findFirst({ where: { id: data.supplierId, active: true } })
    if (!supplier) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })
  }

  if (data.lineUpdates?.length) {
    for (const lr of data.lineUpdates) {
      await db.vendorMaterialPurchaseOrderLine.updateMany({
        where: { id: lr.lineId, vendorPoId: id },
        data: {
          ...(lr.ratePerKg !== undefined ? { ratePerKg: lr.ratePerKg == null ? null : lr.ratePerKg } : {}),
          ...(lr.totalWeightKg !== undefined ? { totalWeightKg: lr.totalWeightKg } : {}),
        },
      })
    }
  }

  const nextStatus = data.status ?? existing.status
  const signatoryName = data.signatoryName ?? existing.signatoryName ?? PROCUREMENT_DEFAULT_SIGNATORY

  const updated = await db.$transaction(async (tx) => {
    const header = await tx.vendorMaterialPurchaseOrder.update({
      where: { id },
      data: {
        ...(data.supplierId !== undefined ? { supplierId: data.supplierId } : {}),
        ...(data.remarks !== undefined ? { remarks: data.remarks } : {}),
        ...(data.paymentTerms !== undefined ? { paymentTerms: data.paymentTerms } : {}),
        ...(data.transportTerms !== undefined ? { transportTerms: data.transportTerms } : {}),
        ...(data.requiredDeliveryDate !== undefined
          ? {
              requiredDeliveryDate: data.requiredDeliveryDate
                ? new Date(data.requiredDeliveryDate)
                : null,
            }
          : {}),
        status: nextStatus,
        signatoryName,
      },
      include: { lines: true, supplier: true },
    })

    return header
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'vendor_material_purchase_orders',
    recordId: id,
    oldValue: {
      status: existing.status,
      supplierId: existing.supplierId,
      requiredDeliveryDate: existing.requiredDeliveryDate,
      paymentTerms: existing.paymentTerms,
      transportTerms: existing.transportTerms,
      remarks: existing.remarks,
      lines: existing.lines.map((line) => ({ id: line.id, totalWeightKg: Number(line.totalWeightKg), ratePerKg: line.ratePerKg == null ? null : Number(line.ratePerKg) })),
    },
    newValue: {
      status: updated.status,
      supplierId: updated.supplierId,
      signatoryName: updated.signatoryName,
      requiredDeliveryDate: updated.requiredDeliveryDate,
      paymentTerms: updated.paymentTerms,
      transportTerms: updated.transportTerms,
      remarks: updated.remarks,
      lines: updated.lines.map((line) => ({ id: line.id, totalWeightKg: Number(line.totalWeightKg), ratePerKg: line.ratePerKg == null ? null : Number(line.ratePerKg) })),
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params

  const existing = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id },
    include: { lines: true, receipts: true },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.receipts.length > 0 || Number(existing.totalReceivedKg) > 0) {
    return NextResponse.json({ error: 'Cannot delete a PO after GRN receipt has started. Short-close or cancel it instead.' }, { status: 409 })
  }

  await db.$transaction(async (tx) => {
    await tx.vendorMaterialPurchaseOrderLine.deleteMany({ where: { vendorPoId: id } })
    await tx.vendorPoRequisitionLink.deleteMany({ where: { vendorPoId: id } })
    await tx.vendorMaterialPurchaseOrder.delete({ where: { id } })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'vendor_material_purchase_orders',
    recordId: id,
    oldValue: {
      poNumber: existing.poNumber,
      supplierId: existing.supplierId,
      status: existing.status,
      lines: existing.lines.map((line) => ({ id: line.id, totalWeightKg: Number(line.totalWeightKg) })),
    },
    newValue: { deleted: true },
  })

  return NextResponse.json({ ok: true })
}
