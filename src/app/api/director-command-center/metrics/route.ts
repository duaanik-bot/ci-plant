import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  lineContributesToWipValue,
  isDirectorBottleneck,
  lineValueRupee,
  toolingSnapshotFromRow,
} from '@/lib/director-command-center-lifecycle'
import { dyeMapFromRows } from '@/lib/po-tooling-critical'

export const dynamic = 'force-dynamic'

const MS_DAY = 86_400_000

export async function GET() {
  const { error /*, user*/ } = await requireAuth()
  if (error) return error

  const lines = await db.poLineItem.findMany({
    where: {
      po: { status: { in: ['draft', 'confirmed'] } },
    },
    include: {
      po: true,
    },
  })

  const jcByNumber = new Map<number, Awaited<ReturnType<typeof db.productionJobCard.findFirst>>>()
  const jobNumbers = Array.from(
    new Set(lines.map((l) => l.jobCardNumber).filter((n): n is number => n != null)),
  )
  for (const num of jobNumbers) {
    if (!jcByNumber.has(num)) {
      const jc = await db.productionJobCard.findFirst({ where: { jobCardNumber: num } })
      jcByNumber.set(num, jc)
    }
  }

  const dieIds = Array.from(
    new Set(
      lines.map((l) => l.dieMasterId).filter((id): id is string => Boolean(id)),
    ),
  )
  const dyeRows =
    dieIds.length > 0
      ? await db.dye.findMany({
          where: { id: { in: dieIds }, active: true },
          select: {
            id: true,
            custodyStatus: true,
            condition: true,
            dyeNumber: true,
            location: true,
            hubStatusFlag: true,
          },
        })
      : []
  const dyeById = dyeMapFromRows(dyeRows)

  let totalWipValue = 0
  let priorityJobs = 0
  let bottlenecks = 0

  const now = new Date()

  for (const li of lines) {
    const jc = li.jobCardNumber ? jcByNumber.get(li.jobCardNumber) ?? null : null
    const d = li.dieMasterId ? dyeById.get(li.dieMasterId) : undefined
    const snap = d ? toolingSnapshotFromRow(d) : null
    if (li.directorPriority) priorityJobs += 1
    if (lineContributesToWipValue(li, li.po, jc, snap)) {
      totalWipValue += lineValueRupee(li)
    }
    if (isDirectorBottleneck(li, li.po, now)) bottlenecks += 1
  }

  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_DAY)
  const closedRecent = await db.purchaseOrder.findMany({
    where: {
      status: 'closed',
      updatedAt: { gte: thirtyDaysAgo },
    },
    select: { poDate: true, updatedAt: true },
  })

  let velocityDays = 0
  if (closedRecent.length > 0) {
    let sum = 0
    for (const p of closedRecent) {
      const start = new Date(p.poDate.getFullYear(), p.poDate.getMonth(), p.poDate.getDate())
      const end = new Date(p.updatedAt.getFullYear(), p.updatedAt.getMonth(), p.updatedAt.getDate())
      sum += Math.max(0, (end.getTime() - start.getTime()) / MS_DAY)
    }
    velocityDays = sum / closedRecent.length
  }

  return NextResponse.json({
    totalWipValue,
    priorityJobs,
    systemBottlenecks: bottlenecks,
    velocityDaysAvg30d: velocityDays,
    velocitySampleCount: closedRecent.length,
  })
}
