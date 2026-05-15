/**
 * Indian GST + invoicing helpers.
 *
 * - Financial year: Apr 1 – Mar 31. We render it as "26-27" (FY 2026-27).
 * - Tax split: intra-state → CGST + SGST (half each of the rate). Inter-state → IGST (full rate).
 * - Invoice numbering: Tally-style `CI/26-27/0001` — short-code + FY + 4-digit sequence.
 * - E-way bill: applicable in India when invoice value ≥ ₹50,000 and a transport mode is recorded.
 *
 * All money values use plain JS numbers in INR (no paise rounding here — round at the persistence layer).
 */

import { COMPANY } from './company-config'

// ─────────────────────────────────────────
// Financial year
// ─────────────────────────────────────────

export function financialYearStringFor(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = date.getMonth() // 0 = Jan
  const startYear = m >= 3 ? y : y - 1 // Apr (m=3) is the new FY
  const endYear = startYear + 1
  return `${String(startYear).slice(-2)}-${String(endYear).slice(-2)}`
}

/// `FY 2026-27` style label for invoice footers.
export function financialYearLabel(fy: string): string {
  const [a, b] = fy.split('-')
  return `FY 20${a}-${b}`
}

// ─────────────────────────────────────────
// Tax split + GST math
// ─────────────────────────────────────────

export type TaxSplit = 'intra' | 'inter'

/**
 * If buyer's state matches seller's state, CGST+SGST split. Otherwise IGST.
 * When buyer state is unknown, we default to intra (safest local default; user can override).
 */
export function resolveTaxSplit(
  buyerStateCode: string | null | undefined,
  sellerStateCode: string = COMPANY.stateCode,
): TaxSplit {
  if (!buyerStateCode) return 'intra'
  return buyerStateCode.trim() === sellerStateCode.trim() ? 'intra' : 'inter'
}

export type GstLineMath = {
  taxableAmount: number
  cgstAmount: number
  sgstAmount: number
  igstAmount: number
  totalAmount: number
}

/**
 * Compute the GST split for a single invoice line.
 * `gstPct` is the *total* GST rate (e.g. 12 for 12% — internally split as 6+6 for intra).
 */
export function computeLineGst(args: {
  quantity: number
  rate: number
  gstPct: number
  split: TaxSplit
}): GstLineMath {
  const qty = Math.max(0, Math.floor(args.quantity))
  const rate = Math.max(0, args.rate)
  const taxable = qty * rate
  const gstFraction = Math.max(0, args.gstPct) / 100
  let cgst = 0
  let sgst = 0
  let igst = 0
  if (args.split === 'intra') {
    cgst = (taxable * gstFraction) / 2
    sgst = (taxable * gstFraction) / 2
  } else {
    igst = taxable * gstFraction
  }
  return {
    taxableAmount: round2(taxable),
    cgstAmount: round2(cgst),
    sgstAmount: round2(sgst),
    igstAmount: round2(igst),
    totalAmount: round2(taxable + cgst + sgst + igst),
  }
}

export type LineForInvoice = {
  description: string
  hsnCode: string | null
  quantity: number
  rate: number
  gstPct: number
  dispatchId?: string | null
  jobCardId?: string | null
}

export type InvoiceTotals = {
  subtotal: number
  cgstAmount: number
  sgstAmount: number
  igstAmount: number
  gstAmount: number
  totalAmount: number
  hsnSummary: HsnSummaryRow[]
  lines: (LineForInvoice & GstLineMath)[]
}

export type HsnSummaryRow = {
  hsn: string
  taxableValue: number
  cgst: number
  sgst: number
  igst: number
  total: number
}

/**
 * Roll lines + split into the full invoice header amounts + per-HSN summary
 * (required on Tally-style tax invoices).
 */
export function computeInvoiceTotals(
  lines: LineForInvoice[],
  split: TaxSplit,
): InvoiceTotals {
  const enriched = lines.map((l) => ({
    ...l,
    ...computeLineGst({
      quantity: l.quantity,
      rate: l.rate,
      gstPct: l.gstPct,
      split,
    }),
  }))

  const subtotal = round2(enriched.reduce((s, l) => s + l.taxableAmount, 0))
  const cgst = round2(enriched.reduce((s, l) => s + l.cgstAmount, 0))
  const sgst = round2(enriched.reduce((s, l) => s + l.sgstAmount, 0))
  const igst = round2(enriched.reduce((s, l) => s + l.igstAmount, 0))
  const gstAmount = round2(cgst + sgst + igst)
  const totalAmount = round2(subtotal + gstAmount)

  // Group by HSN for the footer table.
  const byHsn = new Map<string, HsnSummaryRow>()
  for (const l of enriched) {
    const key = (l.hsnCode || '—').trim() || '—'
    const cur = byHsn.get(key) ?? {
      hsn: key,
      taxableValue: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      total: 0,
    }
    cur.taxableValue = round2(cur.taxableValue + l.taxableAmount)
    cur.cgst = round2(cur.cgst + l.cgstAmount)
    cur.sgst = round2(cur.sgst + l.sgstAmount)
    cur.igst = round2(cur.igst + l.igstAmount)
    cur.total = round2(cur.total + l.totalAmount)
    byHsn.set(key, cur)
  }

  return {
    subtotal,
    cgstAmount: cgst,
    sgstAmount: sgst,
    igstAmount: igst,
    gstAmount,
    totalAmount,
    hsnSummary: Array.from(byHsn.values()),
    lines: enriched,
  }
}

// ─────────────────────────────────────────
// Invoice numbering — Tally style: CI/26-27/0001
// ─────────────────────────────────────────

/// Returns the next sequential number for a given FY. Last-seq is what the DB has;
/// fall back to 0 if nothing exists yet for this FY.
export function nextInvoiceNumberForFy(
  fy: string,
  lastSeqForFy: number,
  shortCode: string = COMPANY.shortCode,
): string {
  const next = Math.max(0, Math.floor(lastSeqForFy)) + 1
  return `${shortCode}/${fy}/${String(next).padStart(4, '0')}`
}

/// Parse a Tally-style number back to its FY + sequence. Returns null for legacy
/// formats like `CI-BILL-2026-0001`.
export function parseInvoiceNumber(billNumber: string): { shortCode: string; fy: string; seq: number } | null {
  const m = billNumber.match(/^([A-Z]{1,4})\/(\d{2}-\d{2})\/(\d+)$/)
  if (!m) return null
  return { shortCode: m[1], fy: m[2], seq: Number(m[3]) }
}

// ─────────────────────────────────────────
// E-way bill applicability
// ─────────────────────────────────────────

/**
 * Indian rule (simplified): e-way bill is mandatory when invoice value ≥ ₹50,000
 * AND goods are being moved (transport mode set). We surface this as a flag on
 * the Bill; the actual EWB number/expiry is captured separately.
 */
export const EWAY_THRESHOLD_INR = 50_000

export function isEwayApplicable(args: {
  invoiceValue: number
  transportMode: string | null | undefined
}): boolean {
  return (
    args.invoiceValue >= EWAY_THRESHOLD_INR &&
    !!args.transportMode &&
    args.transportMode.trim().length > 0
  )
}

// ─────────────────────────────────────────
// Misc
// ─────────────────────────────────────────

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}

/// Format INR with the Indian grouping (1,00,000 not 100,000).
export function fmtINR(n: number, opts?: { withSymbol?: boolean }): string {
  const rounded = round2(n)
  const formatted = rounded.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return opts?.withSymbol === false ? formatted : `₹${formatted}`
}

// ─────────────────────────────────────────
// Amount in words (Tally-style — "Indian Rupees Forty Five Thousand Only")
// ─────────────────────────────────────────

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n]
  const t = Math.floor(n / 10)
  const o = n % 10
  return o === 0 ? TENS[t] : `${TENS[t]} ${ONES[o]}`
}

function threeDigitWords(n: number): string {
  if (n === 0) return ''
  const h = Math.floor(n / 100)
  const r = n % 100
  const parts: string[] = []
  if (h > 0) parts.push(`${ONES[h]} Hundred`)
  if (r > 0) parts.push(twoDigitWords(r))
  return parts.join(' ')
}

export function amountInWordsINR(amount: number): string {
  const n = Math.floor(Math.max(0, amount))
  const paise = Math.round((amount - n) * 100)
  if (n === 0 && paise === 0) return 'Indian Rupees Zero Only'

  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1_000)
  const hundred = n % 1_000

  const parts: string[] = []
  if (crore > 0) parts.push(`${threeDigitWords(crore)} Crore`)
  if (lakh > 0) parts.push(`${twoDigitWords(lakh)} Lakh`)
  if (thousand > 0) parts.push(`${twoDigitWords(thousand)} Thousand`)
  if (hundred > 0) parts.push(threeDigitWords(hundred))

  const rupeesWords = parts.join(' ').replace(/\s+/g, ' ').trim() || 'Zero'
  if (paise > 0) {
    return `Indian Rupees ${rupeesWords} and ${twoDigitWords(paise)} Paise Only`
  }
  return `Indian Rupees ${rupeesWords} Only`
}
