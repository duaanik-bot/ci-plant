import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { buildCustomerPurchaseOrderPdfBuffer } from '@/lib/customer-po-pdf'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: {
      customer: {
        select: { name: true, gstNumber: true },
      },
      lineItems: { orderBy: { createdAt: 'asc' } },
    },
  })

  if (!po) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const poDateYmd = po.poDate.toISOString().slice(0, 10)
  const deliveryYmd = po.deliveryRequiredBy ? po.deliveryRequiredBy.toISOString().slice(0, 10) : null

  const pdfBuffer = buildCustomerPurchaseOrderPdfBuffer({
    poNumber: po.poNumber,
    poDateYmd,
    status: po.status,
    customerName: po.customer.name,
    customerGst: po.customer.gstNumber ?? null,
    deliveryYmd,
    remarks: po.remarks,
    lines: po.lineItems.map((li) => ({
      cartonName: li.cartonName,
      cartonSize: li.cartonSize ?? null,
      quantity: li.quantity,
      rate: li.rate != null ? Number(li.rate) : null,
      gstPct: li.gstPct,
      artworkCode: li.artworkCode ?? null,
    })),
  })

  const safeName = po.poNumber.replace(/[^a-z0-9-_]/gi, '_')
  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}.pdf"`,
    },
  })
}
