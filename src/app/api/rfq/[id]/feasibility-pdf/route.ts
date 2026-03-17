import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { FeasibilityDocument, type RfqPdfModel } from '@/lib/rfq-pdf'

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
    feasibility: {
      boardSpec: fd?.feasibility?.boardSpec ?? null,
      printProcess: fd?.feasibility?.printProcess ?? null,
      estimatedCostPer1000: fd?.feasibility?.estimatedCostPer1000 ?? null,
      toolingCost: fd?.feasibility?.toolingCost ?? null,
      moq: fd?.feasibility?.moq ?? null,
    },
  }

  const pdfBuffer = await renderToBuffer(
    React.createElement(FeasibilityDocument, { model }) as React.ReactElement,
  )

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename=\"feasibility-${rfq.rfqNumber}.pdf\"`,
    },
  })
}

