import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'
import { evaluateFifoForLot, jobFifoSpecFromPoLine } from '@/lib/inventory-aging-fifo'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireRole(
    'stores',
    'shift_supervisor',
    'production_manager',
    'operations_head',
    'md',
  )
  if (error) return error

  const jobCardId = req.nextUrl.searchParams.get('jobCardId')?.trim() ?? ''
  const lotNumber = req.nextUrl.searchParams.get('lotNumber')?.trim() ?? ''
  if (!jobCardId) {
    return NextResponse.json({ error: 'jobCardId required' }, { status: 400 })
  }

  const jc = await db.productionJobCard.findUnique({
    where: { id: jobCardId },
    select: { id: true, jobCardNumber: true },
  })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const poLine = await db.poLineItem.findFirst({
    where: { jobCardNumber: jc.jobCardNumber },
  })

  const spec = poLine ? jobFifoSpecFromPoLine(poLine) : null
  if (!spec) {
    return NextResponse.json({
      fifoSpec: null,
      violation: false,
      olderBatches: [],
      selectedReceiptDate: null,
      message: 'No PO line / GSM spec linked to this job card for FIFO matching.',
    })
  }

  const detail = await evaluateFifoForLot(db, spec, lotNumber || null)

  return NextResponse.json({
    fifoSpec: {
      gsm: spec.gsm,
      boardNorm: spec.boardNorm,
      paperTypeNorm: spec.paperTypeNorm,
      sheetSizeNorm: spec.sheetSizeNorm,
    },
    violation: detail.violation,
    olderBatches: detail.olderBatches,
    selectedReceiptDate: detail.selectedReceiptDate,
  })
}
