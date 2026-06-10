import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { grnNumber, n, ymd } from '@/lib/procurement-foundation'
import { buildProcurementDocumentPdf } from '@/lib/procurement-documents'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const grn = await db.vendorMaterialReceipt.findUnique({
    where: { id },
    include: { vendorPo: { include: { supplier: true, lines: true } } },
  })
  if (!grn) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const accepted = n(grn.qtyAcceptedStandard) + n(grn.qtyAcceptedPenalty)
  const number = grnNumber(grn.id, grn.receiptDate)
  const pdf = buildProcurementDocumentPdf({
    title: 'Goods Receipt Note',
    documentNumber: number,
    rows: [
      { label: 'PO #', value: grn.vendorPo.poNumber },
      { label: 'Supplier', value: grn.vendorPo.supplier.name },
      { label: 'Receipt date', value: ymd(grn.receiptDate) ?? '-' },
      { label: 'Vehicle', value: grn.vehicleNumber },
      { label: 'Invoice / slip', value: grn.scaleSlipId },
      { label: 'Status', value: grn.qcStatus ?? 'QC_PENDING' },
    ],
    lines: grn.vendorPo.lines.map((line) => ({
      Item: `${line.boardGrade} ${line.gsm} GSM`,
      Ordered: `${n(line.totalWeightKg).toFixed(3)} kg`,
      Received: `${n(grn.receivedQty).toFixed(3)} kg`,
      Accepted: `${accepted.toFixed(3)} kg`,
      Rejected: `${n(grn.qtyRejected).toFixed(3)} kg`,
    })),
    remarks: grn.qcRemarks,
  })
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${grnNumber(grn.id, grn.receiptDate)}.pdf"`,
    },
  })
}
