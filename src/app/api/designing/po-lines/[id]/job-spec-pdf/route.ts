import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { JobSpecDocument, type JobSpecPdfModel } from '@/lib/job-spec-pdf'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const li = await db.poLineItem.findUnique({
    where: { id },
    include: { po: { include: { customer: { select: { name: true } } } } },
  })
  if (!li) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const spec = (li.specOverrides as Record<string, unknown> | null) || {}
  const model: JobSpecPdfModel = {
    poNumber: li.po.poNumber,
    poDate: li.po.poDate instanceof Date ? li.po.poDate.toISOString().slice(0, 10) : String(li.po.poDate),
    customerName: li.po.customer.name,
    cartonName: li.cartonName,
    cartonSize: li.cartonSize,
    quantity: li.quantity,
    setNumber: li.setNumber,
    artworkCode: li.artworkCode,
    backPrint: li.backPrint || 'No',
    rate: li.rate != null ? Number(li.rate) : null,
    gsm: li.gsm,
    gstPct: li.gstPct,
    paperType: li.paperType,
    coatingType: li.coatingType,
    embossingLeafing: li.embossingLeafing,
    remarks: li.remarks,
    specOverrides: {
      ups: spec.ups != null ? Number(spec.ups) : undefined,
      requiredSheets: spec.requiredSheets != null ? Number(spec.requiredSheets) : undefined,
      totalSheets: spec.totalSheets != null ? Number(spec.totalSheets) : undefined,
      wastagePct: spec.wastagePct != null ? Number(spec.wastagePct) : undefined,
    },
  }

  const pdfBuffer = await renderToBuffer(
    React.createElement(JobSpecDocument, { model }) as React.ReactElement,
  )

  const filename = `job-spec-${li.po.poNumber}-${li.cartonName.replace(/\s+/g, '-')}.pdf`
  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
    },
  })
}
