import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { renderToBuffer } from '@react-pdf/renderer'
import QRCode from 'qrcode'
import React from 'react'
import { JobCardDocument } from '@/lib/job-card-pdf'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const job = await db.job.findUnique({
    where: { id },
    include: { customer: { select: { name: true } } },
  })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const qrDataUrl = await QRCode.toDataURL(id, { width: 200, margin: 1 })
  const jobForPdf = {
    id: job.id,
    jobNumber: job.jobNumber,
    productName: job.productName,
    qtyOrdered: job.qtyOrdered,
    imposition: job.imposition,
    dueDate: job.dueDate.toISOString().slice(0, 10),
    status: job.status,
    customer: job.customer,
  }

  const pdfBuffer = await renderToBuffer(
    React.createElement(JobCardDocument, {
      job: jobForPdf,
      qrDataUrl,
    }) as React.ReactElement
  )

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="job-${job.jobNumber}.pdf"`,
    },
  })
}
