import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const jobs = await db.job.findMany({
    where: { status: { in: ['pending_artwork', 'artwork_approved', 'in_production', 'folding', 'final_qc', 'packing'] } },
    include: {
      customer: { select: { name: true } },
      workflowStages: true,
    },
    orderBy: { dueDate: 'asc' },
  })

  const mapped = jobs.map((job) => {
    const stages = job.workflowStages
    const current =
      stages.find((s) => s.status === 'in_progress') ||
      stages.find((s) => s.status === 'pending') ||
      null
    const completedCount = stages.filter((s) => s.status === 'completed').length
    const pct = stages.length ? Math.round((completedCount / stages.length) * 100) : 0

    return {
      id: job.id,
      jobNumber: job.jobNumber,
      productName: job.productName,
      customerName: job.customer.name,
      currentStageNumber: current?.stageNumber ?? null,
      currentStageName: current?.stageName ?? null,
      percentComplete: pct,
      dueDate: job.dueDate,
    }
  })

  return NextResponse.json(mapped)
}

