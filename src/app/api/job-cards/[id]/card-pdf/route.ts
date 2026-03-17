import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import {
  ProductionJobCardDocument,
  type ProductionJobCardPdfModel,
} from '@/lib/production-job-card-pdf'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const jc = await db.productionJobCard.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true } },
      stages: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const model: ProductionJobCardPdfModel = {
    jobCardNumber: jc.jobCardNumber,
    customerName: jc.customer.name,
    setNumber: jc.setNumber,
    batchNumber: jc.batchNumber,
    requiredSheets: jc.requiredSheets,
    wastageSheets: jc.wastageSheets,
    totalSheets: jc.totalSheets,
    sheetsIssued: jc.sheetsIssued,
    status: jc.status,
    artworkApproved: jc.artworkApproved,
    firstArticlePass: jc.firstArticlePass,
    finalQcPass: jc.finalQcPass,
    qaReleased: jc.qaReleased,
    stages: jc.stages.map((s) => ({
      stageName: s.stageName,
      status: s.status,
      operator: s.operator,
      counter: s.counter,
    })),
  }

  const pdfBuffer = await renderToBuffer(
    React.createElement(ProductionJobCardDocument, { model }) as React.ReactElement,
  )

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="job-card-${jc.jobCardNumber}.pdf"`,
    },
  })
}
