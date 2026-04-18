import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import QRCode from 'qrcode'
import {
  ProductionJobCardDocument,
  type ProductionJobCardPdfModel,
} from '@/lib/production-job-card-pdf'
import { computeBoardMaterialForJobCard } from '@/lib/job-card-board-material'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
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
      allocatedPaperWarehouse: { select: { lotNumber: true } },
    },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const poLine =
    jc.jobCardNumber != null
      ? await db.poLineItem.findFirst({
          where: { jobCardNumber: jc.jobCardNumber },
          select: {
            materialProcurementStatus: true,
            materialQueue: {
              select: { totalSheets: true, boardType: true, gsm: true },
            },
          },
        })
      : null

  const boardMaterial = await computeBoardMaterialForJobCard(
    db,
    { id: jc.id, totalSheets: jc.totalSheets, sheetsIssued: jc.sheetsIssued },
    poLine
      ? {
          materialProcurementStatus: poLine.materialProcurementStatus,
          materialQueue: poLine.materialQueue,
        }
      : null,
  )

  const boardMaterialFooter = `Material Verified against Batch ${boardMaterial.batchLotNumber ?? '—'}. Board Status: ${boardMaterial.boardStatus === 'available' ? 'Available' : 'Out of stock'}.`
  const batchHandshake =
    boardMaterial.batchLotNumber ?? jc.allocatedPaperWarehouse?.lotNumber ?? '—'
  const inventoryHandshakeFooter = `Inventory Handshake Verified. Material Batch ${batchHandshake} locked for Job ${jc.jobCardNumber}.`

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const verifyUrl = host ? `${proto}://${host}/production/job-cards/${id}` : null

  let qrDataUrl: string | null = null
  if (verifyUrl) {
    try {
      qrDataUrl = await QRCode.toDataURL(verifyUrl, {
        margin: 1,
        width: 180,
        color: { dark: '#ffffff', light: '#000000' },
        errorCorrectionLevel: 'M',
      })
    } catch {
      qrDataUrl = null
    }
  }

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
    qrDataUrl,
    verifyUrl,
    materialPendingWatermark: boardMaterial.materialPendingWatermark,
    boardMaterialFooter,
    inventoryHandshakeFooter,
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
