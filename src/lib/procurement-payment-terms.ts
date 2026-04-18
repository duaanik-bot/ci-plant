import type { PrismaClient } from '@prisma/client'
import { normalizeBoardKey } from '@/lib/procurement-price-benchmark'

export type TermsBand = 'advance' | 'near_cash' | 'credit'

export type CashFlowTermsDto = {
  paymentTermsDays: number
  termsBand: TermsBand
  badgeLabel: string
  latestReceiptYmd: string | null
  projectedPaymentYmd: string | null
  accruedPayableInr: number | null
  primarySupplierName: string | null
  isProvisional: boolean
  alternativeBetterTerms: { supplierName: string; extraDays: number } | null
}

export function classifyPaymentTermsBand(paymentTermsDays: number): TermsBand {
  if (paymentTermsDays <= 0) return 'advance'
  if (paymentTermsDays >= 30) return 'credit'
  return 'near_cash'
}

/** Grid badge: Credit-{N}, Near-Cash (1–7d), Net-{N} (8–29d), Advance Required */
export function paymentTermsBadgeLabel(paymentTermsDays: number): string {
  if (paymentTermsDays <= 0) return 'Advance Required'
  if (paymentTermsDays >= 30) return `Credit-${paymentTermsDays}`
  if (paymentTermsDays <= 7) return 'Near-Cash'
  return `Net-${paymentTermsDays}`
}

export function ymdUtcFromDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addCalendarDaysToYmd(ymd: string, days: number): string {
  const [y, m, da] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, da))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

export function maxReceiptYmd(receipts: { receiptDate: Date }[]): string | null {
  if (!receipts.length) return null
  let max = receipts[0]!.receiptDate
  for (const r of receipts) {
    if (r.receiptDate > max) max = r.receiptDate
  }
  return ymdUtcFromDate(max)
}

/** projected_payment_date = latest GRN receipt date + payment_terms_days (calendar). */
export function projectedPaymentYmdFromReceipts(
  receipts: { receiptDate: Date }[],
  paymentTermsDays: number,
): string | null {
  const ymd = maxReceiptYmd(receipts)
  if (!ymd) return null
  return addCalendarDaysToYmd(ymd, Math.max(0, paymentTermsDays))
}

export type VendorPoCashRow = {
  id: string
  status: string
  accruedReceiptPayableInr: unknown
  supplier: { id: string; name: string; paymentTermsDays: number }
  receipts: { receiptDate: Date }[]
}

export function buildCashFlowTermsFromVendorPo(
  row: VendorPoCashRow,
  primarySupplierName: string | null,
  boardType: string,
  gsm: number,
  betterIndex: Map<string, SupplierTermsOption[]>,
): CashFlowTermsDto {
  const terms = row.supplier.paymentTermsDays ?? 30
  const accrued = Number(row.accruedReceiptPayableInr ?? 0)
  const latest = maxReceiptYmd(row.receipts)
  const projected = projectedPaymentYmdFromReceipts(row.receipts, terms)
  const alt = pickBetterTermsAlternative(betterIndex, boardType, gsm, row.supplier.id, terms)
  return {
    paymentTermsDays: terms,
    termsBand: classifyPaymentTermsBand(terms),
    badgeLabel: paymentTermsBadgeLabel(terms),
    latestReceiptYmd: latest,
    projectedPaymentYmd: projected,
    accruedPayableInr: accrued > 0 ? Math.round(accrued * 100) / 100 : null,
    primarySupplierName,
    isProvisional: !latest,
    alternativeBetterTerms: alt,
  }
}

export function buildProvisionalCashFlowTerms(
  paymentTermsDays: number,
  supplierName: string | null,
  boardType: string,
  gsm: number,
  suggestedSupplierId: string | null,
  betterIndex: Map<string, SupplierTermsOption[]>,
): CashFlowTermsDto {
  const t = paymentTermsDays
  return {
    paymentTermsDays: t,
    termsBand: classifyPaymentTermsBand(t),
    badgeLabel: paymentTermsBadgeLabel(t),
    latestReceiptYmd: null,
    projectedPaymentYmd: null,
    accruedPayableInr: null,
    primarySupplierName: supplierName,
    isProvisional: true,
    alternativeBetterTerms: pickBetterTermsAlternative(
      betterIndex,
      boardType,
      gsm,
      suggestedSupplierId,
      t,
    ),
  }
}

export type SupplierTermsOption = {
  supplierId: string
  supplierName: string
  paymentTermsDays: number
}

export async function loadBetterTermsIndex(db: PrismaClient): Promise<Map<string, SupplierTermsOption[]>> {
  const lines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: {
      vendorPo: { dispatchedAt: { not: null }, isShortClosed: false },
    },
    select: {
      boardGrade: true,
      gsm: true,
      vendorPo: {
        select: {
          supplierId: true,
          supplier: { select: { name: true, paymentTermsDays: true } },
        },
      },
    },
    take: 12_000,
  })
  const m = new Map<string, SupplierTermsOption[]>()
  for (const ln of lines) {
    const k = `${normalizeBoardKey(ln.boardGrade)}|${ln.gsm}`
    const sid = ln.vendorPo.supplierId
    const name = ln.vendorPo.supplier.name
    const days = ln.vendorPo.supplier.paymentTermsDays ?? 30
    if (!m.has(k)) m.set(k, [])
    const arr = m.get(k)!
    const ex = arr.find((x) => x.supplierId === sid)
    if (!ex) arr.push({ supplierId: sid, supplierName: name, paymentTermsDays: days })
    else if (days > ex.paymentTermsDays) ex.paymentTermsDays = days
  }
  return m
}

export function pickBetterTermsAlternative(
  index: Map<string, SupplierTermsOption[]>,
  boardType: string,
  gsm: number,
  currentSupplierId: string | null,
  currentTermsDays: number,
): { supplierName: string; extraDays: number } | null {
  const k = `${normalizeBoardKey(boardType)}|${gsm}`
  const arr = index.get(k) ?? []
  let best = 0
  let bestName: string | null = null
  for (const r of arr) {
    if (currentSupplierId && r.supplierId === currentSupplierId) continue
    const extra = r.paymentTermsDays - currentTermsDays
    if (extra > best) {
      best = extra
      bestName = r.supplierName
    }
  }
  if (best <= 0 || !bestName) return null
  return { supplierName: bestName, extraDays: best }
}

export async function loadVendorPoCashRows(
  db: PrismaClient,
  ids: string[],
): Promise<Map<string, VendorPoCashRow>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (!unique.length) return new Map()
  const rows = await db.vendorMaterialPurchaseOrder.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      status: true,
      accruedReceiptPayableInr: true,
      supplier: { select: { id: true, name: true, paymentTermsDays: true } },
      receipts: { select: { receiptDate: true } },
    },
  })
  return new Map(rows.map((r) => [r.id, r as VendorPoCashRow]))
}

/** Sum accrued payable on received mill POs with projected due date in [today, today+30]. */
export async function computePendingPayables30dInr(db: PrismaClient): Promise<number> {
  const todayYmd = ymdUtcFromDate(new Date())
  const endYmd = addCalendarDaysToYmd(todayYmd, 30)

  const pos = await db.vendorMaterialPurchaseOrder.findMany({
    where: {
      isShortClosed: false,
      status: { in: ['partially_received', 'fully_received'] },
    },
    select: {
      accruedReceiptPayableInr: true,
      supplier: { select: { paymentTermsDays: true } },
      receipts: { select: { receiptDate: true } },
    },
  })

  let sum = 0
  for (const po of pos) {
    const payable = Number(po.accruedReceiptPayableInr ?? 0)
    if (payable <= 0) continue
    const terms = po.supplier.paymentTermsDays ?? 30
    const proj = projectedPaymentYmdFromReceipts(po.receipts, terms)
    if (!proj || proj < todayYmd || proj > endYmd) continue
    sum += payable
  }
  return Math.round(sum * 100) / 100
}
