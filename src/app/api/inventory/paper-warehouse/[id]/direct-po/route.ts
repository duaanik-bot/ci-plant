import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, createAuditLog } from '@/lib/helpers'
import { db } from '@/lib/db'
import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  supplierId: z.string().uuid(),
  qtyKg: z.number().positive(),
  sizeLabel: z.string().optional(),
  ratePerKg: z.number().positive().optional(),
  deliveryDate: z.string().datetime().optional(),
  paymentTerms: z.string().max(200).optional(),
  transportTerms: z.string().max(200).optional(),
  remarks: z.string().max(500).optional(),
})

function buildPoNumber(existingMax: string | null): string {
  const now = new Date()
  const yyyymmdd =
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`
  const prefix = `PO-${yyyymmdd}-`
  if (!existingMax || !existingMax.startsWith(prefix)) return `${prefix}001`
  const seq = parseInt(existingMax.replace(prefix, ''), 10) || 0
  return `${prefix}${String(seq + 1).padStart(3, '0')}`
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole(
    'stores',
    'production_manager',
    'operations_head',
    'md',
  )
  if (error) return error

  const { id: materialId } = await context.params

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.flatten() }, { status: 400 })
  }

  const { supplierId, qtyKg, ratePerKg, deliveryDate, paymentTerms, transportTerms, remarks } =
    parsed.data

  const material = await db.inventory.findUnique({ where: { id: materialId } })
  if (!material) return NextResponse.json({ error: 'Material not found' }, { status: 404 })
  if (!material.boardType || material.gsm == null) {
    return NextResponse.json(
      { error: 'Material is missing boardType or gsm — cannot create PO line' },
      { status: 400 },
    )
  }

  const supplier = await db.supplier.findFirst({ where: { id: supplierId, active: true } })
  if (!supplier) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })

  // Capture date once so prefix generation and lookup use the same base
  const now = new Date()
  const yyyymmdd =
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`
  const todayPrefix = `PO-${yyyymmdd}-`

  const result = await db.$transaction(async (tx) => {
    const prefix = todayPrefix
    const latest = await tx.vendorMaterialPurchaseOrder.findFirst({
      where: { poNumber: { startsWith: prefix } },
      orderBy: { poNumber: 'desc' },
      select: { poNumber: true },
    })
    const poNumber = buildPoNumber(latest?.poNumber ?? null)

    const po = await tx.vendorMaterialPurchaseOrder.create({
      data: {
        poNumber,
        supplierId,
        materialId,
        createdBy: user!.id,
        requiredDeliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
        paymentTerms,
        transportTerms,
        remarks,
        lines: {
          create: [
            {
              boardGrade: normalizeBoardTypeForStorage(material.boardType) ?? material.boardType!,
              gsm: material.gsm!,
              totalSheets: 0,
              totalWeightKg: qtyKg,
              ...(ratePerKg ? { ratePerKg } : {}),
              linkedPoLineIds: [{ materialId: material.id, materialCode: material.materialCode, source: 'paper_warehouse_direct_po' }],
            },
          ],
        },
      },
    })
    return po
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'vendor_material_purchase_orders',
    recordId: result.id,
    oldValue: null,
    newValue: { poNumber: result.poNumber, materialId, supplierId, qtyKg },
  })

  return NextResponse.json({ poId: result.id, poNumber: result.poNumber })
}
