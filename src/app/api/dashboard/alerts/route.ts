import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const [excess, artworkPending] = await Promise.all([
    db.sheetIssue.findMany({
      where: { isExcess: true, approvedAt: null, rejectedAt: null },
      take: 5,
      include: { job: { select: { jobNumber: true } } },
    }),
    db.artwork.findMany({
      where: { status: { in: ['pending', 'partially_approved'] } },
      take: 5,
      include: { job: { select: { jobNumber: true, productName: true } } },
    }),
  ])

  const alerts: {
    type: string
    severity: 'critical' | 'warning' | 'info'
    title: string
    description: string
    link: string
    jobId?: string
  }[] = []

  for (const e of excess) {
    alerts.push({
      type: 'excess_sheet',
      severity: 'critical',
      title: 'Excess sheet request',
      description: `Job ${e.job.jobNumber} — approve excess sheets`,
      link: `/stores/approve-excess/${e.id}`,
      jobId: e.jobId,
    })
  }

  for (const a of artworkPending) {
    alerts.push({
      type: 'artwork',
      severity: 'warning',
      title: 'Artwork lock pending',
      description: `${a.job.jobNumber} — ${a.job.productName}`,
      link: `/artwork/${a.jobId}`,
      jobId: a.jobId,
    })
  }

  return NextResponse.json(alerts)
}

