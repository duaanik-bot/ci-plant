import type { PrismaClient } from '@prisma/client'
import { computeJobYieldMetricsForCard } from '@/lib/production-yield'

export const PERFORMANCE_INCENTIVE_AUDIT_MESSAGE = 'Performance Incentive Verified by Anik Dua.'

function mean(nums: number[]): number {
  if (!nums.length) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Resolve operator for a ledger row (attributed at close, else shift operator on job). */
export function resolveLedgerOperatorId(ledger: {
  attributedOperatorUserId: string | null
  jobCard: { shiftOperatorUserId: string | null }
}): string | null {
  return ledger.attributedOperatorUserId ?? ledger.jobCard.shiftOperatorUserId ?? null
}

/**
 * Downtime efficiency: average run-time ratio (run/shift × 100) — higher = less logged downtime drag.
 */
export function downtimeEfficiencyFromLedgers(
  rows: Array<{ runMinutes: number; shiftMinutes: number }>,
): number {
  if (!rows.length) return 0
  const ratios = rows.map((r) =>
    r.shiftMinutes > 0 ? (r.runMinutes / r.shiftMinutes) * 100 : 0,
  )
  return round1(mean(ratios))
}

export type LeaderboardOperatorRow = {
  userId: string
  name: string
  rank: number
  performanceIndex: number
  avgOee: number
  avgYield: number
  downtimeEfficiency: number
  oeeSparkline: number[]
  jobCount: number
  underperformer: boolean
}

export async function buildOperatorLeaderboard(
  db: PrismaClient,
  opts?: { sinceDays?: number },
): Promise<LeaderboardOperatorRow[]> {
  const sinceDays = opts?.sinceDays ?? 28
  const since = new Date()
  since.setDate(since.getDate() - sinceDays)

  const ledgers = await db.productionOeeLedger.findMany({
    where: { computedAt: { gte: since } },
    include: {
      jobCard: {
        select: {
          shiftOperatorUserId: true,
          wastageSheets: true,
          totalSheets: true,
        },
      },
    },
    orderBy: { computedAt: 'asc' },
  })

  const byOp = new Map<
    string,
    Array<{
      oee: number
      yieldPct: number | null
      runMinutes: number
      shiftMinutes: number
      computedAt: Date
    }>
  >()

  for (const L of ledgers) {
    const opId = resolveLedgerOperatorId(L)
    if (!opId) continue
    const y = L.yieldPercent != null ? Number(L.yieldPercent) : null
    if (!byOp.has(opId)) byOp.set(opId, [])
    byOp.get(opId)!.push({
      oee: Number(L.oeePct),
      yieldPct: y,
      runMinutes: L.runMinutes,
      shiftMinutes: L.shiftMinutes,
      computedAt: L.computedAt,
    })
  }

  const userIds = Array.from(byOp.keys())
  if (userIds.length === 0) return []

  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  })
  const nameById = new Map(users.map((u) => [u.id, u.name]))

  const rows: LeaderboardOperatorRow[] = []
  for (const [userId, jobs] of Array.from(byOp.entries())) {
    const avgOee = round1(mean(jobs.map((j) => j.oee)))
    const yields = jobs.map((j) => j.yieldPct).filter((y): y is number => y != null && y > 0)
    const avgYield = yields.length ? round1(mean(yields)) : avgOee
    const de = downtimeEfficiencyFromLedgers(jobs)
    const performanceIndex = round1(avgOee * 0.4 + avgYield * 0.4 + de * 0.2)
    const sorted = [...jobs].sort((a, b) => a.computedAt.getTime() - b.computedAt.getTime())
    const last7 = sorted.slice(-7)
    const oeeSparkline = last7.map((j) => j.oee)
    rows.push({
      userId,
      name: nameById.get(userId) ?? userId.slice(0, 8),
      rank: 0,
      performanceIndex,
      avgOee,
      avgYield,
      downtimeEfficiency: de,
      oeeSparkline,
      jobCount: jobs.length,
      underperformer: performanceIndex < 40,
    })
  }

  rows.sort((a, b) => b.performanceIndex - a.performanceIndex)
  rows.forEach((r, i) => {
    r.rank = i + 1
  })

  return rows
}

export async function computeFactoryAvgWastagePct(db: PrismaClient, since: Date): Promise<number> {
  const ledgers = await db.productionOeeLedger.findMany({
    where: { computedAt: { gte: since } },
    include: {
      jobCard: { select: { wastageSheets: true, totalSheets: true } },
    },
  })
  const rates = ledgers
    .map((L) => {
      const t = L.jobCard.totalSheets
      if (t <= 0) return null
      return (L.jobCard.wastageSheets / t) * 100
    })
    .filter((x): x is number => x != null)
  return rates.length ? round1(mean(rates)) : 0
}

export type OperatorProfilePayload = {
  user: { id: string; name: string }
  jobCount: number
  avgOee: number
  avgYield: number
  avgWastagePct: number
  factoryAvgWastagePct: number
  machineHistory: Array<{ machineCode: string; machineName: string; jobCount: number; avgOee: number }>
  downtimeSignature: Array<{ reasonKey: string; count: number; totalMinutes: number }>
}

export async function buildOperatorProfile(
  db: PrismaClient,
  operatorUserId: string,
  opts?: { sinceDays?: number },
): Promise<OperatorProfilePayload | null> {
  const user = await db.user.findUnique({
    where: { id: operatorUserId },
    select: { id: true, name: true },
  })
  if (!user) return null

  const sinceDays = opts?.sinceDays ?? 90
  const since = new Date()
  since.setDate(since.getDate() - sinceDays)

  const ledgers = await db.productionOeeLedger.findMany({
    where: { computedAt: { gte: since } },
    include: {
      jobCard: {
        select: {
          shiftOperatorUserId: true,
          wastageSheets: true,
          totalSheets: true,
        },
      },
      machine: { select: { machineCode: true, name: true } },
    },
  })

  const mine = ledgers.filter((L) => resolveLedgerOperatorId(L) === operatorUserId)
  if (mine.length === 0) {
    const downtimeSignature = await downtimeSignatureForOperator(db, operatorUserId, since)
    return {
      user,
      jobCount: 0,
      avgOee: 0,
      avgYield: 0,
      avgWastagePct: 0,
      factoryAvgWastagePct: await computeFactoryAvgWastagePct(db, since),
      machineHistory: [],
      downtimeSignature,
    }
  }

  const avgOee = round1(mean(mine.map((L) => Number(L.oeePct))))
  const yields = mine
    .map((L) => (L.yieldPercent != null ? Number(L.yieldPercent) : null))
    .filter((y): y is number => y != null)
  const avgYield = yields.length ? round1(mean(yields)) : avgOee

  const wastageRates = mine
    .map((L) => {
      const t = L.jobCard.totalSheets
      if (t <= 0) return null
      return (L.jobCard.wastageSheets / t) * 100
    })
    .filter((x): x is number => x != null)
  const avgWastagePct = wastageRates.length ? round1(mean(wastageRates)) : 0
  const factoryAvg = await computeFactoryAvgWastagePct(db, since)

  const byMachine = new Map<string, { machineCode: string; machineName: string; oees: number[] }>()
  for (const L of mine) {
    if (!L.machine) continue
    const k = L.machine.machineCode
    if (!byMachine.has(k)) {
      byMachine.set(k, {
        machineCode: L.machine.machineCode,
        machineName: L.machine.name,
        oees: [],
      })
    }
    byMachine.get(k)!.oees.push(Number(L.oeePct))
  }
  const machineHistory = Array.from(byMachine.values())
    .map((m) => ({
      machineCode: m.machineCode,
      machineName: m.machineName,
      jobCount: m.oees.length,
      avgOee: round1(mean(m.oees)),
    }))
    .sort((a, b) => b.avgOee - a.avgOee)

  const downtimeSignature = await downtimeSignatureForOperator(db, operatorUserId, since)

  return {
    user,
    jobCount: mine.length,
    avgOee,
    avgYield,
    avgWastagePct,
    factoryAvgWastagePct: factoryAvg,
    machineHistory,
    downtimeSignature,
  }
}

async function downtimeSignatureForOperator(db: PrismaClient, operatorUserId: string, since: Date) {
  const logs = await db.productionDowntimeLog.findMany({
    where: { operatorUserId, startedAt: { gte: since }, durationSeconds: { not: null } },
    select: { reasonCategory: true, durationSeconds: true },
  })
  const map = new Map<string, { count: number; totalSec: number }>()
  for (const l of logs) {
    const cur = map.get(l.reasonCategory) ?? { count: 0, totalSec: 0 }
    cur.count += 1
    cur.totalSec += l.durationSeconds ?? 0
    map.set(l.reasonCategory, cur)
  }
  return Array.from(map.entries())
    .map(([reasonKey, v]) => ({
      reasonKey,
      count: v.count,
      totalMinutes: round1(v.totalSec / 60),
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes)
}
