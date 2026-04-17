import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { PROCUREMENT_DEFAULT_SIGNATORY } from '@/lib/procurement-mrp-service'

export const dynamic = 'force-dynamic'

const putSchema = z.object({
  status: z.enum(['draft', 'confirmed', 'cancelled']).optional(),
  signatoryName: z.string().min(1).max(120).optional(),
  remarks: z.string().nullable().optional(),
  requiredDeliveryDate: z.string().nullable().optional(),
  lineRates: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        ratePerKg: z.number().nonnegative().nullable(),
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
    },
  })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(row)
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

  if (data.lineRates?.length) {
    for (const lr of data.lineRates) {
      await db.vendorMaterialPurchaseOrderLine.updateMany({
        where: { id: lr.lineId, vendorPoId: id },
        data: {
          ratePerKg: lr.ratePerKg == null ? null : lr.ratePerKg,
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
        ...(data.remarks !== undefined ? { remarks: data.remarks } : {}),
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
    newValue: { status: updated.status, signatoryName: updated.signatoryName },
  })

  return NextResponse.json(updated)
}
