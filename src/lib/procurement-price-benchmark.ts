import type { PrismaClient } from '@prisma/client'

/** Vendor PO states used for 30-day market benchmark (confirmed + material received). */
export const BENCHMARK_VENDOR_PO_STATUSES = ['confirmed', 'partially_received', 'fully_received'] as const

/** Open / committed orders for monthly leakage (not yet fully received). */
export const ORDERED_VENDOR_PO_STATUSES_LEAKAGE = ['confirmed', 'dispatched'] as const

const MS_DAY = 86_400_000

export function normalizeBoardKey(boardGrade: string): string {
  return boardGrade.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function boardGradesMatch(lineBoard: string, needleNorm: string): boolean {
  const g = normalizeBoardKey(lineBoard)
  const n = needleNorm
  return g === n || g.includes(n) || n.includes(g)
}

export function priceVariancePct(currentRate: number, benchmarkRate: number): number {
  if (!Number.isFinite(currentRate) || !Number.isFinite(benchmarkRate) || benchmarkRate <= 0) return 0
  return ((currentRate - benchmarkRate) / benchmarkRate) * 100
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0)
}

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/** Month bucket from PO orderDate (calendar) or createdAt. */
function monthKeyForPo(orderDate: Date | null, createdAt: Date): string {
  if (orderDate) {
    return ymd(new Date(orderDate.getFullYear(), orderDate.getMonth(), 1))
  }
  return ymd(new Date(createdAt.getFullYear(), createdAt.getMonth(), 1))
}

export type BenchmarkHit = {
  ratePerKg: number
  supplierName: string
  vendorPoNumber: string
}

export type TrendMonthPoint = {
  monthKey: string
  avgRate: number
  high: number
  low: number
  lastPaid: number
}

export async function computeMarketBenchmark30d(
  db: PrismaClient,
  boardGrade: string,
  gsm: number,
): Promise<BenchmarkHit | null> {
  const norm = normalizeBoardKey(boardGrade)
  if (!norm || !Number.isFinite(gsm) || gsm <= 0) return null

  const since = new Date(Date.now() - 30 * MS_DAY)
  const sinceDateOnly = new Date(since.getFullYear(), since.getMonth(), since.getDate())

  const lines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: {
      gsm,
      ratePerKg: { not: null, gt: 0 },
      vendorPo: {
        isShortClosed: false,
        status: { in: [...BENCHMARK_VENDOR_PO_STATUSES] },
        OR: [{ orderDate: { gte: sinceDateOnly } }, { createdAt: { gte: since } }],
      },
    },
    select: {
      ratePerKg: true,
      boardGrade: true,
      vendorPo: {
        select: {
          poNumber: true,
          supplier: { select: { name: true } },
        },
      },
    },
  })

  let best: BenchmarkHit | null = null
  let bestRate = Infinity
  for (const ln of lines) {
    if (!boardGradesMatch(ln.boardGrade, norm)) continue
    const r = Number(ln.ratePerKg)
    if (!Number.isFinite(r) || r <= 0) continue
    if (r < bestRate) {
      bestRate = r
      best = {
        ratePerKg: r,
        supplierName: ln.vendorPo.supplier.name,
        vendorPoNumber: ln.vendorPo.poNumber,
      }
    }
  }
  return best
}

/** Last 6 calendar months (including current) — average / high / low / last paid for matching lines. */
export async function computePriceTrend6m(
  db: PrismaClient,
  boardGrade: string,
  gsm: number,
): Promise<{
  months: TrendMonthPoint[]
  seriesHigh: number
  seriesLow: number
  lastPaid: number | null
}> {
  const norm = normalizeBoardKey(boardGrade)
  const empty = { months: [] as TrendMonthPoint[], seriesHigh: 0, seriesLow: 0, lastPaid: null as number | null }
  if (!norm || !Number.isFinite(gsm) || gsm <= 0) return empty

  const now = new Date()
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 5, 1)

  const lines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: {
      gsm,
      ratePerKg: { not: null, gt: 0 },
      vendorPo: {
        isShortClosed: false,
        status: { in: [...BENCHMARK_VENDOR_PO_STATUSES, 'dispatched'] },
        OR: [{ orderDate: { gte: windowStart } }, { createdAt: { gte: windowStart } }],
      },
    },
    orderBy: { vendorPo: { createdAt: 'desc' } },
    select: {
      ratePerKg: true,
      boardGrade: true,
      vendorPo: { select: { orderDate: true, createdAt: true } },
    },
  })

  const matched = lines.filter((ln) => boardGradesMatch(ln.boardGrade, norm))
  if (matched.length === 0) return empty

  const bucket = new Map<
    string,
    { sum: number; n: number; high: number; low: number; lastPaid: number; lastTs: number }
  >()

  for (const ln of matched) {
    const mk = monthKeyForPo(ln.vendorPo.orderDate, ln.vendorPo.createdAt)
    const r = Number(ln.ratePerKg)
    if (!Number.isFinite(r) || r <= 0) continue
    const ts = ln.vendorPo.createdAt.getTime()
    const cur = bucket.get(mk) ?? { sum: 0, n: 0, high: r, low: r, lastPaid: r, lastTs: ts }
    cur.sum += r
    cur.n += 1
    cur.high = Math.max(cur.high, r)
    cur.low = Math.min(cur.low, r)
    if (ts >= cur.lastTs) {
      cur.lastTs = ts
      cur.lastPaid = r
    }
    bucket.set(mk, cur)
  }

  const months: TrendMonthPoint[] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = ymd(d)
    const b = bucket.get(key)
    if (b && b.n > 0) {
      months.push({
        monthKey: key,
        avgRate: Math.round((b.sum / b.n) * 100) / 100,
        high: b.high,
        low: b.low,
        lastPaid: b.lastPaid,
      })
    }
  }

  const allRates = matched.map((ln) => Number(ln.ratePerKg)).filter((r) => Number.isFinite(r) && r > 0)
  const seriesHigh = allRates.length ? Math.max(...allRates) : 0
  const seriesLow = allRates.length ? Math.min(...allRates) : 0
  const lastPaid = matched.length ? Number(matched[0]!.ratePerKg) : null

  return { months, seriesHigh, seriesLow, lastPaid }
}

/**
 * Sum over open ordered lines this month: max(0, rate - benchmark) × kg.
 * Benchmark = 30-day global minimum per (gsm, normalized board) across vendors.
 */
export async function computeProcurementLeakageMtdInr(db: PrismaClient): Promise<number> {
  const now = new Date()
  const monthStart = startOfMonth(now)
  const since = new Date(Date.now() - 30 * MS_DAY)
  const sinceDateOnly = new Date(since.getFullYear(), since.getMonth(), since.getDate())

  const [benchLines, orderedLines] = await Promise.all([
    db.vendorMaterialPurchaseOrderLine.findMany({
      where: {
        ratePerKg: { not: null, gt: 0 },
        vendorPo: {
          isShortClosed: false,
          status: { in: [...BENCHMARK_VENDOR_PO_STATUSES] },
          OR: [{ orderDate: { gte: sinceDateOnly } }, { createdAt: { gte: since } }],
        },
      },
      select: { gsm: true, boardGrade: true, ratePerKg: true },
    }),
    db.vendorMaterialPurchaseOrderLine.findMany({
      where: {
        ratePerKg: { not: null, gt: 0 },
        vendorPo: {
          isShortClosed: false,
          status: { in: [...ORDERED_VENDOR_PO_STATUSES_LEAKAGE] },
          OR: [{ orderDate: { gte: monthStart } }, { createdAt: { gte: monthStart } }],
        },
      },
      select: {
        gsm: true,
        boardGrade: true,
        ratePerKg: true,
        totalWeightKg: true,
      },
    }),
  ])

  const minByKey = new Map<string, number>()
  for (const ln of benchLines) {
    const key = `${ln.gsm}|${normalizeBoardKey(ln.boardGrade)}`
    const r = Number(ln.ratePerKg)
    if (!Number.isFinite(r) || r <= 0) continue
    const prev = minByKey.get(key)
    if (prev == null || r < prev) minByKey.set(key, r)
  }

  let leakage = 0
  for (const ln of orderedLines) {
    const key = `${ln.gsm}|${normalizeBoardKey(ln.boardGrade)}`
    const bench = minByKey.get(key)
    if (bench == null || bench <= 0) continue
    const rate = Number(ln.ratePerKg)
    const kg = Number(ln.totalWeightKg)
    if (!Number.isFinite(rate) || !Number.isFinite(kg) || kg <= 0) continue
    const delta = rate - bench
    if (delta > 0) leakage += delta * kg
  }

  return Math.round(leakage * 100) / 100
}
