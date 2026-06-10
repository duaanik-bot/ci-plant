import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { n } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error
  const movements = await db.stockMovement.findMany({
    where: { movementType: 'procurement_inward', refType: 'procurement_grn' },
    take: 50,
    orderBy: { createdAt: 'desc' },
    include: { material: { select: { materialCode: true, description: true, unit: true } } },
  })
  const receiptIds = movements.map((m) => m.refId).filter((x): x is string => Boolean(x))
  const receipts = receiptIds.length
    ? await db.vendorMaterialReceipt.findMany({
        where: { id: { in: receiptIds } },
        include: { vendorPo: { include: { supplier: true } } },
      })
    : []
  const byId = new Map(receipts.map((r) => [r.id, r]))
  return NextResponse.json({
    rows: movements.map((m) => {
      const r = m.refId ? byId.get(m.refId) : null
      return {
        id: m.id,
        date: m.createdAt.toISOString(),
        materialCode: m.material.materialCode,
        description: m.material.description,
        acceptedQty: n(m.qty),
        rejectedQty: n(r?.qtyRejected),
        uom: m.material.unit,
        grnReference: m.refId ? `GRN-${m.createdAt.getFullYear()}-${m.refId.slice(0, 8).toUpperCase()}` : '-',
        poReference: r?.vendorPo.poNumber ?? '-',
        supplier: r?.vendorPo.supplier.name ?? '-',
        note: m.reservedByName ?? '',
      }
    }),
  })
}
