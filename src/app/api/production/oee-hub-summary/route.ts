import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { isUnplannedDowntimeCategory } from '@/lib/production-oee'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const now = new Date()
  const weekStart = new Date(now)
  weekStart.setDate(weekStart.getDate() - 7)
  weekStart.setHours(0, 0, 0, 0)

  const logs = await db.productionDowntimeLog.findMany({
    where: {
      startedAt: { gte: weekStart },
      durationSeconds: { not: null },
    },
    select: { reasonCategory: true, durationSeconds: true },
  })

  const secondsByReason = new Map<string, number>()
  for (const l of logs) {
    const add = l.durationSeconds ?? 0
    secondsByReason.set(l.reasonCategory, (secondsByReason.get(l.reasonCategory) ?? 0) + add)
  }

  let topBottleneck: { reasonKey: string; hours: number } | null = null
  for (const [reasonKey, sec] of Array.from(secondsByReason.entries())) {
    const h = sec / 3600
    if (!topBottleneck || h > topBottleneck.hours) {
      topBottleneck = { reasonKey, hours: Math.round(h * 10) / 10 }
    }
  }

  const unplannedStops = logs.filter((l) => isUnplannedDowntimeCategory(l.reasonCategory)).length

  const ledgers = await db.productionOeeLedger.findMany({
    where: { computedAt: { gte: weekStart } },
    select: { oeePct: true, runMinutes: true },
  })

  let plantOee: number | null = null
  if (ledgers.length > 0) {
    let w = 0
    let sum = 0
    for (const l of ledgers) {
      const rm = Math.max(1, l.runMinutes)
      const o = Number(l.oeePct)
      sum += o * rm
      w += rm
    }
    plantOee = Math.round((sum / w) * 10) / 10
  }

  return NextResponse.json({
    plantOee,
    topBottleneck,
    unplannedStops,
    weekStartedAt: weekStart.toISOString(),
  })
}
