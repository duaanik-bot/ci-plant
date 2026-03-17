import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Returns job with BOM lines and for each line: approved qty, already issued, remaining.
 * Used by the stores issue tablet after scanning a job QR.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole(
    'stores',
    'shift_supervisor',
    'production_manager',
    'operations_head',
    'md'
  )
  if (error) return error

  const { id: jobId } = await context.params

  const job = await db.job.findUnique({
    where: { id: jobId },
    include: {
      customer: { select: { name: true } },
      bomLines: {
        include: {
          material: { select: { materialCode: true, description: true, unit: true } },
        },
      },
    },
  })

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const bomLinesWithRemaining = await Promise.all(
    job.bomLines.map(async (line) => {
      const issuedSum = await db.sheetIssue.aggregate({
        where: {
          bomLineId: line.id,
          OR: [
            { isExcess: false },
            { isExcess: true, approvedAt: { not: null }, rejectedAt: null },
          ],
        },
        _sum: { qtyRequested: true },
      })
      const approved = Number(line.qtyApproved)
      const alreadyIssued = Number(issuedSum._sum.qtyRequested ?? 0)
      const remaining = Math.max(0, approved - alreadyIssued)
      return {
        id: line.id,
        materialCode: line.material.materialCode,
        materialDescription: line.material.description,
        unit: line.material.unit,
        qtyApproved: approved,
        qtyAlreadyIssued: alreadyIssued,
        remaining,
      }
    })
  )

  return NextResponse.json({
    id: job.id,
    jobNumber: job.jobNumber,
    productName: job.productName,
    customerName: job.customer.name,
    bomLines: bomLinesWithRemaining,
  })
}
