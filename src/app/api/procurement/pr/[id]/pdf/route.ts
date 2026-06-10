import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { n, prNumber, ymd } from '@/lib/procurement-foundation'
import { buildProcurementDocumentPdf } from '@/lib/procurement-documents'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const pr = await db.purchaseRequisition.findUnique({ where: { id }, include: { material: true } })
  if (!pr) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const number = prNumber(pr.id, pr.raisedAt)
  const pdf = buildProcurementDocumentPdf({
    title: 'Purchase Requisition',
    documentNumber: number,
    rows: [
      { label: 'Status', value: pr.status },
      { label: 'Raised by', value: pr.raisedBy ?? '-' },
      { label: 'Required date', value: ymd(pr.requiredByDate) ?? '-' },
      { label: 'Current stock', value: (n(pr.material.qtyAvailable) + n(pr.material.qtyReserved)).toLocaleString('en-IN') },
      { label: 'Available stock', value: n(pr.material.qtyAvailable).toLocaleString('en-IN') },
    ],
    lines: [{
      Item: `${pr.material.materialCode} - ${pr.material.description}`,
      Qty: `${n(pr.qtyRequired).toLocaleString('en-IN')} ${pr.material.unit}`,
    }],
    remarks: pr.remarks,
  })
  return new NextResponse(new Uint8Array(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${prNumber(pr.id, pr.raisedAt)}.pdf"` } })
}
