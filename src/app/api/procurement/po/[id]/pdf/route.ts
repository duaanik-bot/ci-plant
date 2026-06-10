import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { buildVendorMaterialPoPdfBuffer } from '@/lib/vendor-po-pdf'
import { n, ymd } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const po = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, lines: true },
  })
  if (!po) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const pdf = buildVendorMaterialPoPdfBuffer({
    poNumber: po.poNumber,
    supplierName: po.supplier.name,
    signatoryName: po.signatoryName,
    requiredDeliveryYmd: ymd(po.requiredDeliveryDate),
    remarks: po.remarks,
    lines: po.lines.map((line) => ({
      boardGrade: line.boardGrade,
      gsm: line.gsm,
      grainDirection: line.grainDirection,
      totalSheets: line.totalSheets,
      totalWeightKg: n(line.totalWeightKg),
      ratePerKg: line.ratePerKg == null ? null : n(line.ratePerKg),
    })),
  })
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${po.poNumber.replace(/[^a-z0-9-_]/gi, '_')}.pdf"`,
    },
  })
}
