import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { n, ymd } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const po = await db.vendorMaterialPurchaseOrder.findUnique({ where: { id }, include: { supplier: true, lines: true } })
  if (!po) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const amount = po.lines.reduce((s, line) => s + n(line.totalWeightKg) * n(line.ratePerKg), 0)
  return NextResponse.json({
    email: po.supplier.email,
    phone: po.supplier.contactPhone,
    message: `Dear ${po.supplier.name}, please find attached Purchase Order ${po.poNumber} dated ${ymd(po.orderDate) ?? '-'} for ₹${Math.round(amount).toLocaleString('en-IN')}. Kindly confirm delivery schedule by ${ymd(po.requiredDeliveryDate) ?? 'the agreed date'}.`,
  })
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const po = await db.vendorMaterialPurchaseOrder.update({
    where: { id },
    data: {
      logisticsStatus: 'supplier_confirmed',
      logisticsUpdatedAt: new Date(),
      remarks: [body.note ? `Supplier confirmation: ${body.note}` : 'Supplier confirmation received'].join('\n'),
    },
  })
  await createAuditLog({ userId: user!.id, action: 'UPDATE', tableName: 'vendor_material_purchase_orders', recordId: id, newValue: { event: 'PO_SUPPLIER_CONFIRMATION_RECEIVED', poNumber: po.poNumber, note: body.note ?? null } })
  return NextResponse.json({ ok: true })
}
