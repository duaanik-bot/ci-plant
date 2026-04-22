import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** PO summary for Planning drawer: lines, value, customer address, PO status. */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ poId: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { poId } = await context.params
  if (!poId) return NextResponse.json({ error: 'poId required' }, { status: 400 })

  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          address: true,
          contactName: true,
          contactPhone: true,
          email: true,
        },
      },
      lineItems: {
        select: {
          id: true,
          cartonName: true,
          quantity: true,
          rate: true,
          gstPct: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 })

  let total = 0
  for (const li of po.lineItems) {
    const qty = li.quantity ?? 0
    const rate = li.rate != null ? Number(li.rate) : 0
    const gst = (li.gstPct ?? 12) / 100
    total += qty * rate * (1 + gst)
  }

  return NextResponse.json({
    id: po.id,
    poNumber: po.poNumber,
    poDate: po.poDate,
    status: po.status,
    deliveryRequiredBy: po.deliveryRequiredBy,
    remarks: po.remarks,
    isPriority: po.isPriority,
    customer: po.customer,
    lineItems: po.lineItems.map((li) => ({
      id: li.id,
      cartonName: li.cartonName,
      quantity: li.quantity,
      rate: li.rate != null ? Number(li.rate) : null,
      gstPct: li.gstPct,
    })),
    totalValueInr: Math.round(total * 100) / 100,
    billTo: po.customer?.address ?? '—',
    /** No separate ship-to in schema; surface delivery + remarks. */
    shipTo: po.deliveryRequiredBy
      ? `Target delivery: ${po.deliveryRequiredBy.toISOString().slice(0, 10)}`
      : (po.remarks?.trim() || 'As per customer address'),
    paymentStatus: po.status,
  })
}
