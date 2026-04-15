import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { PlateLabelDocument, type PlateLabelModel } from '@/lib/plate-label-pdf'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const plate = await db.plateStore.findUnique({
    where: { id },
    include: { customer: { select: { name: true } } },
  })
  if (!plate) return NextResponse.json({ error: 'Plate set not found' }, { status: 404 })

  const colours = Array.isArray(plate.colours)
    ? (plate.colours as Array<{ name?: string }>).map((c) => c.name || '').filter(Boolean).join(' ')
    : ''

  const model: PlateLabelModel = {
    plateSetCode: plate.plateSetCode,
    cartonName: plate.cartonName,
    artworkVersion: plate.artworkVersion ?? 'R0',
    customerName: plate.customer?.name ?? '-',
    colours,
    ctpDate: plate.ctpDate ? new Date(plate.ctpDate).toLocaleDateString('en-IN') : '-',
    rack: plate.rackLocation ?? '-',
    slot: plate.slotNumber ?? '-',
  }

  const pdfBuffer = await renderToBuffer(
    React.createElement(PlateLabelDocument, { model }) as React.ReactElement,
  )

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="plate-label-${plate.plateSetCode}.pdf"`,
    },
  })
}
