import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const [excess, artworkPending, pendingCtp, partialDestroyed, issuedCount, polishEmboss] =
    await Promise.all([
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
      db.plateRequirement.findMany({
        where: { status: { in: ['pending', 'ctp_notified'] } },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
      db.plateStore.findMany({
        where: { status: 'partially_destroyed' },
        take: 5,
        orderBy: { updatedAt: 'desc' },
      }),
      db.plateStore.count({ where: { status: 'issued' } }),
      db.embossBlock.findMany({
        where: {
          OR: [{ condition: 'Needs Polish' }, { impressionCount: { gt: 85000 } }],
        },
        take: 5,
        orderBy: { updatedAt: 'desc' },
      }),
    ])

  const overduePlates: {
    jobCardNumber?: number | null
    cartonName?: string | null
    jobCardId?: string | null
  }[] = []
  const overdueDies: {
    jobCardNumber?: number | null
    dieNumber?: string | null
    dieCode?: string | null
    jobCardId?: string | null
    id?: string
    maxImpressions?: number
    impressionCount?: number
  }[] = []
  const sharpenDies: (typeof overdueDies)[number][] = []
  const endOfLifeDies: { dieCode?: string | null; id?: string }[] = []
  const overdueOrders: {
    expectedBy?: Date | null
    orderCode?: string | null
    jobCardId?: string | null
  }[] = []
  const receivedOrders: { orderCode?: string | null; jobCardId?: string | null }[] = []
  const overdueEmboss: {
    jobCardNumber?: number | null
    blockCode?: string | null
    jobCardId?: string | null
  }[] = []
  const overdueEmbossOrders: (typeof overdueOrders)[number][] = []
  const receivedEmbossOrders: (typeof receivedOrders)[number][] = []

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

  for (const p of overduePlates) {
    alerts.push({
      type: 'plate_overdue_return',
      severity: 'critical',
      title: 'Plates overdue for return',
      description: `Job ${p.jobCardNumber ?? '-'} - ${p.cartonName ?? 'carton'}`,
      link: '/pre-press/plate-store',
      jobId: p.jobCardId ?? undefined,
    })
  }

  for (const r of pendingCtp) {
    alerts.push({
      type: 'ctp_requirement_pending',
      severity: 'warning',
      title: 'CTP requirement pending',
      description: `${r.cartonName} - ${r.newPlatesNeeded} new plates needed`,
      link: '/pre-press/plate-store?tab=plates&section=ctp',
      jobId: r.jobCardId ?? undefined,
    })
  }

  for (const d of partialDestroyed) {
    alerts.push({
      type: 'plate_partial_destroyed',
      severity: 'warning',
      title: 'Plates partially destroyed',
      description: `${d.plateSetCode} - check stock`,
      link: `/pre-press/plate-store/${d.id}`,
    })
  }

  alerts.push({
    type: 'plate_stock_snapshot',
    severity: 'info',
    title: 'Plate stock status',
    description: `Currently issued: ${issuedCount}`,
    link: '/pre-press/plate-store',
  })

  for (const d of overdueDies) {
    alerts.push({
      type: 'die_overdue_return',
      severity: 'critical',
      title: 'Die overdue for return',
      description: `Job ${d.jobCardNumber ?? '-'} - Die ${d.dieNumber ?? d.dieCode}`,
      link: '/masters/dies',
      jobId: d.jobCardId ?? undefined,
    })
  }

  for (const d of sharpenDies) {
    const pct = d.maxImpressions > 0 ? Math.round((d.impressionCount / d.maxImpressions) * 100) : 0
    alerts.push({
      type: 'die_needs_sharpening',
      severity: 'warning',
      title: 'Die needs sharpening',
      description: `No.${d.dieNumber ?? '-'} at ${pct}% life`,
      link: `/masters/dies/${d.id}`,
    })
  }

  for (const d of endOfLifeDies) {
    alerts.push({
      type: 'die_end_of_life',
      severity: 'warning',
      title: 'Die at end of life',
      description: `Die ${d.dieCode} - consider replacement`,
      link: `/masters/dies/${d.id}`,
    })
  }

  for (const o of overdueOrders) {
    const days = o.expectedBy ? Math.max(1, Math.floor((Date.now() - new Date(o.expectedBy).getTime()) / (1000 * 60 * 60 * 24))) : 0
    alerts.push({
      type: 'die_vendor_overdue',
      severity: 'critical',
      title: 'New die order overdue',
      description: `${o.orderCode} - ${days} days late`,
      link: '/masters/dies/vendor-orders',
      jobId: o.jobCardId ?? undefined,
    })
  }

  for (const o of receivedOrders) {
    alerts.push({
      type: 'die_vendor_received',
      severity: 'info',
      title: 'Vendor order received',
      description: `Die order ${o.orderCode} ready to use`,
      link: '/masters/dies/vendor-orders',
      jobId: o.jobCardId ?? undefined,
    })
  }

  for (const e of overdueEmboss) {
    alerts.push({
      type: 'emboss_overdue_return',
      severity: 'critical',
      title: 'Emboss block overdue for return',
      description: `Job ${e.jobCardNumber ?? '-'} - ${e.blockCode}`,
      link: '/masters/emboss-blocks',
      jobId: e.jobCardId ?? undefined,
    })
  }

  for (const e of polishEmboss) {
    const pct = e.maxImpressions > 0 ? Math.round((e.impressionCount / e.maxImpressions) * 100) : 0
    alerts.push({
      type: 'emboss_needs_polish',
      severity: 'warning',
      title: 'Emboss block needs polishing',
      description: `${e.blockCode} at ${pct}% life`,
      link: `/masters/emboss-blocks/${e.id}`,
    })
  }

  for (const o of overdueEmbossOrders) {
    const days = o.expectedBy ? Math.max(1, Math.floor((Date.now() - new Date(o.expectedBy).getTime()) / (1000 * 60 * 60 * 24))) : 0
    alerts.push({
      type: 'emboss_vendor_overdue',
      severity: 'critical',
      title: 'New emboss block order overdue',
      description: `${o.orderCode} - ${days} days late`,
      link: '/masters/emboss-blocks/vendor-orders',
      jobId: o.jobCardId ?? undefined,
    })
  }

  for (const o of receivedEmbossOrders) {
    alerts.push({
      type: 'emboss_vendor_received',
      severity: 'info',
      title: 'Emboss block vendor order received',
      description: `${o.orderCode} - ready to use`,
      link: '/masters/emboss-blocks/vendor-orders',
      jobId: o.jobCardId ?? undefined,
    })
  }

  return NextResponse.json(alerts)
}

