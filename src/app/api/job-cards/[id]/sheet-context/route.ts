import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'

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

  const productName =
    (await db.poLineItem.findFirst({
      where: { jobCardNumber: jc.jobCardNumber },
      select: { cartonName: true },
    }))?.cartonName ?? `Job Card #${jc.jobCardNumber}`

  return NextResponse.json({
    type: 'job_card',
    id: jc.id,
    jobNumber: `JC#${jc.jobCardNumber}`,
    productName,
    customerName: jc.customer.name,
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
