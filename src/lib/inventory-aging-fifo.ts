import type { PrismaClient } from '@prisma/client'
import { boardGradesMatch, normalizeBoardKey } from '@/lib/procurement-price-benchmark'

/** Minimal client for FIFO queries (works with `$transaction` callback client). */
export type PaperWarehouseDb = Pick<PrismaClient, 'paperWarehouse'>

export type StockAgeBucket = 'fresh' | 'mature' | 'stale'

const MS_DAY = 86_400_000

/** Calendar age in whole days: current date minus gate (receipt) date. */
export function stockAgeDaysUtc(receiptDate: Date, now: Date = new Date()): number {
  const a = Date.UTC(receiptDate.getFullYear(), receiptDate.getMonth(), receiptDate.getDate())
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.max(0, Math.floor((b - a) / MS_DAY))
}

export function stockAgeCategory(days: number): StockAgeBucket {
  if (days <= 30) return 'fresh'
  if (days <= 60) return 'mature'
  return 'stale'
}

export type JobFifoSpec = {
  gsm: number
  boardNorm: string
  paperTypeNorm: string
  sheetSizeNorm: string
}

export function normalizeFifoText(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** GSM + grade + size proxy (paper type + PO line sheet size label). */
export function jobFifoSpecFromPoLine(poLine: {
  gsm: number | null
  paperType: string | null
  cartonSize?: string | null
}): JobFifoSpec | null {
  const gsm = poLine.gsm
  if (gsm == null || !Number.isFinite(gsm) || gsm <= 0) return null
  const pt = poLine.paperType ?? ''
  const boardNorm = normalizeBoardKey(pt)
  if (!boardNorm) return null
  const size = normalizeFifoText(poLine.cartonSize ?? '')
  return {
    gsm,
    boardNorm,
    paperTypeNorm: normalizeFifoText(pt),
    sheetSizeNorm: size,
  }
}

export function paperRowMatchesFifoSpec(
  row: {
    gsm: number
    boardGrade: string | null
    paperType: string
  },
  spec: JobFifoSpec,
): boolean {
  if (row.gsm !== spec.gsm) return false
  const whBoard = row.boardGrade?.trim() ? row.boardGrade : row.paperType
  if (!boardGradesMatch(whBoard, spec.boardNorm)) return false
  const whPaper = normalizeFifoText(row.paperType)
  if (spec.paperTypeNorm && whPaper && whPaper !== spec.paperTypeNorm) return false
  return true
}

export type FifoViolationDetail = {
  violation: boolean
  selectedReceiptDate: string | null
  olderBatches: {
    id: string
    lotNumber: string | null
    receiptDate: string
    ageDays: number
    qtySheets: number
  }[]
}

export async function evaluateFifoForLot(
  db: PaperWarehouseDb,
  spec: JobFifoSpec,
  lotNumber: string | null | undefined,
): Promise<FifoViolationDetail> {
  const lot = (lotNumber ?? '').trim()
  if (!lot) {
    return { violation: false, selectedReceiptDate: null, olderBatches: [] }
  }

  const candidates = await db.paperWarehouse.findMany({
    where: { lotNumber: lot, qtySheets: { gt: 0 } },
  })
  const selected = candidates.find((c) => paperRowMatchesFifoSpec(c, spec))
  if (!selected) {
    return { violation: false, selectedReceiptDate: null, olderBatches: [] }
  }

  const allSameSpec = await db.paperWarehouse.findMany({
    where: { gsm: spec.gsm, qtySheets: { gt: 0 } },
  })

  const peers = allSameSpec.filter((r) => paperRowMatchesFifoSpec(r, spec))
  const selTime = new Date(selected.receiptDate).getTime()
  const older = peers.filter((r) => {
    if (r.id === selected.id) return false
    return new Date(r.receiptDate).getTime() < selTime
  })

  const now = new Date()
  const olderBatches = older
    .map((r) => ({
      id: r.id,
      lotNumber: r.lotNumber,
      receiptDate: new Date(r.receiptDate).toISOString().slice(0, 10),
      ageDays: stockAgeDaysUtc(new Date(r.receiptDate), now),
      qtySheets: r.qtySheets,
    }))
    .sort((a, b) => a.receiptDate.localeCompare(b.receiptDate))

  return {
    violation: olderBatches.length > 0,
    selectedReceiptDate: new Date(selected.receiptDate).toISOString().slice(0, 10),
    olderBatches,
  }
}

export async function computeStalePaperCapitalInr(db: PaperWarehouseDb, now: Date = new Date()): Promise<number> {
  const rows = await db.paperWarehouse.findMany({
    where: { qtySheets: { gt: 0 } },
    select: { receiptDate: true, qtySheets: true, rate: true },
  })
  let sum = 0
  for (const r of rows) {
    const days = stockAgeDaysUtc(new Date(r.receiptDate), now)
    if (days <= 60) continue
    const rate = r.rate != null ? Number(r.rate) : 0
    if (!Number.isFinite(rate) || rate <= 0) continue
    sum += r.qtySheets * rate
  }
  return Math.round(sum * 100) / 100
}

export function fifoOverrideAuditMessage(userDisplayName: string, reason: string): string {
  return `FIFO Override by ${userDisplayName.trim() || 'User'} - Reason: ${reason.trim()}.`
}
