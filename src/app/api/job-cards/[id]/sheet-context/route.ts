import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { jobFifoSpecFromPoLine } from '@/lib/inventory-aging-fifo'

export const dynamic = 'force-dynamic'

/**
 * Returns job card sheet context for stores issue: total sheets, issued, remaining.
 * Single virtual "line" so the stores UI can reuse the same flow.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireRole(
    'stores',
    'shift_supervisor',
    'production_manager',
    'operations_head',
    'md',
  )
  if (error) return error

  const { id } = await context.params
  const jc = await db.productionJobCard.findUnique({
    where: { id },
    include: { customer: { select: { name: true } } },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const totalSheets = jc.totalSheets
  const sheetsIssued = jc.sheetsIssued
  const remaining = Math.max(0, totalSheets - sheetsIssued)

  const poLine = await db.poLineItem.findFirst({
    where: { jobCardNumber: jc.jobCardNumber },
  })
  const productName = poLine?.cartonName ?? `Job Card #${jc.jobCardNumber}`
  const fifoSpecDto = poLine ? jobFifoSpecFromPoLine(poLine) : null

  return NextResponse.json({
    type: 'job_card',
    id: jc.id,
    jobNumber: `JC#${jc.jobCardNumber}`,
    productName,
    customerName: jc.customer.name,
    fifoSpec: fifoSpecDto
      ? {
          gsm: fifoSpecDto.gsm,
          boardNorm: fifoSpecDto.boardNorm,
          paperTypeNorm: fifoSpecDto.paperTypeNorm,
          sheetSizeNorm: fifoSpecDto.sheetSizeNorm,
        }
      : null,
    bomLines: [
      {
        id: jc.id,
        type: 'job_card',
        materialCode: 'Sheets',
        materialDescription: 'Sheets',
        unit: 'sheets',
        qtyApproved: totalSheets,
        qtyAlreadyIssued: sheetsIssued,
        remaining,
      },
    ],
  })
}
