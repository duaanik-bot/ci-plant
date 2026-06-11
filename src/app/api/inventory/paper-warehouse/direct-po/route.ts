import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, createAuditLog } from '@/lib/helpers'
import { db } from '@/lib/db'
import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  supplierId: z.string().uuid(),
  lines: z.array(z.object({ materialId: z.string().uuid(), qtyKg: z.number().positive() })).min(1),
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

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.flatten() }, { status: 400 })
  }

  const { supplierId, lines, deliveryDate, paymentTerms, transportTerms, remarks } = parsed.data
  const supplier = await db.supplier.findFirst({ where: { id: supplierId, active: true } })
  if (!supplier) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })

  const materials = await db.inventory.findMany({ where: { id: { in: lines.map((l) => l.materialId) } } })
  if (materials.length !== lines.length) return NextResponse.json({ error: 'One or more materials not found' }, { status: 404 })
  const materialById = new Map(materials.map((m) => [m.id, m]))
  const incomplete = materials.filter((m) => !m.boardType || m.gsm == null)
  if (incomplete.length > 0) {
    return NextResponse.json({ error: `Materials missing boardType/gsm: ${incomplete.map((m) => m.materialCode).join(', ')}` }, { status: 400 })
  }

  const result = await db.$transaction(async (tx) => {
    const now = new Date()
    const prefix =
      `PO-${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}-`
    const latest = await tx.vendorMaterialPurchaseOrder.findFirst({
      where: { poNumber: { startsWith: prefix } },
      orderBy: { poNumber: 'desc' },
      select: { poNumber: true },
    })

    return tx.vendorMaterialPurchaseOrder.create({
      data: {
        poNumber: buildPoNumber(latest?.poNumber ?? null),
        supplierId,
        createdBy: user!.id,
        requiredDeliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
        paymentTerms,
        transportTerms,
        remarks,
        lines: {
          create: lines.map((line) => {
            const material = materialById.get(line.materialId)!
            return {
              boardGrade: normalizeBoardTypeForStorage(material.boardType) ?? material.boardType!,
              gsm: material.gsm!,
              totalSheets: 0,
              totalWeightKg: line.qtyKg,
              linkedPoLineIds: [{ materialId: material.id, materialCode: material.materialCode, source: 'paper_warehouse_bulk_vendor_po' }],
            }
          }),
        },
      },
    })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'vendor_material_purchase_orders',
    recordId: result.id,
    oldValue: null,
    newValue: { poNumber: result.poNumber, supplierId, lines },
  })

  return NextResponse.json({ poId: result.id, poNumber: result.poNumber, lineCount: lines.length })
}
