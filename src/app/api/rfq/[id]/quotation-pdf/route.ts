import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { QuotationDocument, type RfqPdfModel } from '@/lib/rfq-pdf'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const rfq = await db.rfq.findUnique({
    where: { id },
    include: { customer: { select: { name: true } } },
  })
  if (!rfq) return NextResponse.json({ error: 'RFQ not found' }, { status: 404 })

  const fd = rfq.feasibilityData as any
  const model: RfqPdfModel = {
    rfqNumber: rfq.rfqNumber,
    customerName: rfq.customer.name,
    productName: rfq.productName,
    packType: rfq.packType,
    createdAt: rfq.createdAt.toISOString().slice(0, 10),
    feasibility: {},
    quotation: {
      quotationNumber: rfq.quotationNumber ?? null,
      unitPrice: fd?.quotation?.unitPrice ?? null,
      tooling: fd?.quotation?.tooling ?? null,
      paymentTerms: fd?.quotation?.paymentTerms ?? null,
      validity: fd?.quotation?.validity ?? null,
      notes: fd?.quotation?.notes ?? null,
    },
  }

  const pdfBuffer = await renderToBuffer(
    React.createElement(QuotationDocument, { model }) as React.ReactElement,
  )

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename=\"quotation-${rfq.quotationNumber ?? rfq.rfqNumber}.pdf\"`,
    },
  })
}

