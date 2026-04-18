import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { computeStalePaperCapitalInr, stockAgeCategory, stockAgeDaysUtc } from '@/lib/inventory-aging-fifo'
import {
  estimateKgForSheets,
  linkedCustomerPoNumbersForPaperRow,
  loadMaterialQueuesForPriority,
  paperRowIndustrialPriority,
  resolveKgPerSheetForPaper,
  warehouseBoardLabel,
} from '@/lib/paper-interconnect'
import { normalizeBoardKey } from '@/lib/procurement-price-benchmark'

export const dynamic = 'force-dynamic'

function isMainWarehouseLocation(loc: string | null): boolean {
  if (loc == null || loc.trim() === '') return true
  return loc.trim().toUpperCase() !== 'FLOOR'
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const customerPoQ = req.nextUrl.searchParams.get('customerPo')?.trim().toLowerCase() ?? ''

  const [rows, staleCapitalInr, queues] = await Promise.all([
    db.paperWarehouse.findMany({
      where: { qtySheets: { gt: 0 } },
      orderBy: [{ receiptDate: 'asc' }],
    }),
    computeStalePaperCapitalInr(db),
    loadMaterialQueuesForPriority(db),
  ])

  const ids = rows.map((r) => r.id)
  const issuedAgg =
    ids.length > 0
      ? await db.paperIssueToFloor.groupBy({
          by: ['sourcePaperWarehouseId'],
          where: { sourcePaperWarehouseId: { in: ids } },
          _sum: { qtySheets: true },
        })
      : []
  const issuedBySource = new Map(issuedAgg.map((g) => [g.sourcePaperWarehouseId, g._sum.qtySheets ?? 0]))

  const linkedPoCache = new Map<string, string[]>()
  async function linkedPos(row: (typeof rows)[0]): Promise<string[]> {
    const k = `${row.gsm}|${normalizeBoardKey(warehouseBoardLabel(row))}`
    if (linkedPoCache.has(k)) return linkedPoCache.get(k)!
    const nums = await linkedCustomerPoNumbersForPaperRow(db, row)
    linkedPoCache.set(k, nums)
    return nums
  }

  const kgPerSheetCache = new Map<string, number | null>()
  async function kgPerSheetFor(row: (typeof rows)[0]): Promise<number | null> {
    const k = `${row.gsm}|${normalizeBoardKey(warehouseBoardLabel(row))}`
    if (kgPerSheetCache.has(k)) return kgPerSheetCache.get(k)!
    const v = await resolveKgPerSheetForPaper(db, row)
    kgPerSheetCache.set(k, v)
    return v
  }

  const now = new Date()
  const payloadUnfiltered = await Promise.all(
    rows.map(async (r) => {
      const rd = new Date(r.receiptDate)
      const ageDays = stockAgeDaysUtc(rd, now)
      const bucket = stockAgeCategory(ageDays)
      const rate = r.rate != null ? Number(r.rate) : 0
      const valueInr = Number.isFinite(rate) && rate > 0 ? Math.round(r.qtySheets * rate * 100) / 100 : 0
      const industrialPriority = paperRowIndustrialPriority(r, queues)
      const totalIssuedToFloor = issuedBySource.get(r.id) ?? 0
      const linkedCustomerPos = await linkedPos(r)
      const kgPerSheet = await kgPerSheetFor(r)
      const estKgRemaining = estimateKgForSheets(r.qtySheets, kgPerSheet)
      const suggestBalanceWriteOff =
        estKgRemaining != null && estKgRemaining > 0 && estKgRemaining < 50 && isMainWarehouseLocation(r.location)
      return {
        id: r.id,
        lotNumber: r.lotNumber,
        paperType: r.paperType,
        boardGrade: r.boardGrade,
        gsm: r.gsm,
        qtySheets: r.qtySheets,
        ratePerSheet: r.rate != null ? Number(r.rate) : null,
        valueInr,
        receiptDate: rd.toISOString().slice(0, 10),
        ageDays,
        ageBucket: bucket,
        status: r.status,
        location: r.location,
        industrialPriority,
        totalIssuedToFloor,
        linkedCustomerPos,
        isMainWarehouse: isMainWarehouseLocation(r.location),
        estKgRemaining,
        suggestBalanceWriteOff,
      }
    }),
  )

  let payload = payloadUnfiltered
  if (customerPoQ) {
    payload = payload.filter((p) =>
      p.linkedCustomerPos.some((n) => n.toLowerCase().includes(customerPoQ)),
    )
  }

  payload.sort((a, b) => {
    if (a.isMainWarehouse !== b.isMainWarehouse) return a.isMainWarehouse ? -1 : 1
    const pa = a.industrialPriority ? 1 : 0
    const pb = b.industrialPriority ? 1 : 0
    if (pa !== pb) return pb - pa
    return a.receiptDate.localeCompare(b.receiptDate)
  })

  return NextResponse.json({ rows: payload, staleCapitalInr })
}
