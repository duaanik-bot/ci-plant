import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error, user } = await requireAuth()
  if (error) return error

  const pending = await db.sheetIssue.findMany({
    where: {
      isExcess: true,
      approvedAt: null,
      rejectedAt: null,
    },
    include: {
      job: { select: { jobNumber: true, productName: true } },
      material: { select: { materialCode: true, description: true, unit: true } },
      bomLine: { select: { qtyApproved: true } },
    },
    orderBy: { issuedAt: 'desc' },
  })

  const withAlreadyIssued = await Promise.all(
    pending.map(async (p) => {
      const issuedSum = await db.sheetIssue.aggregate({
        where: {
          bomLineId: p.bomLineId,
          OR: [
            { isExcess: false },
            { isExcess: true, approvedAt: { not: null }, rejectedAt: null },
          ],
          id: { not: p.id },
        },
        _sum: { qtyRequested: true },
      })
      const approved = Number(p.bomLine.qtyApproved)
      const alreadyIssued = Number(issuedSum._sum.qtyRequested ?? 0)
      return {
        id: p.id,
        jobId: p.jobId,
        jobNumber: p.job.jobNumber,
        productName: p.job.productName,
        materialCode: p.material.materialCode,
        materialDescription: p.material.description,
        unit: p.material.unit,
        qtyApproved: approved,
        qtyAlreadyIssued: alreadyIssued,
        qtyRequested: Number(p.qtyRequested),
        reasonCode: p.reasonCode,
        reasonDetail: p.reasonDetail,
        issuedAt: p.issuedAt.toISOString(),
      }
    })
  )

  return NextResponse.json(withAlreadyIssued)
}
