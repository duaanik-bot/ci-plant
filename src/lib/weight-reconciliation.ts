import type { PrismaClient } from '@prisma/client'

/** Audit / UI copy for auto-drafted debit notes. */
export const DEBIT_NOTE_DRAFT_SIGNATURE =
  'Drafted by System - Awaiting Approval by Anik Dua/Saachi.'

/** Above this |variance %|, show red + offer debit note draft (short-weight). */
export const WEIGHT_VARIANCE_DEBIT_TOLERANCE_PCT = 1.5

export type WeightVarianceUiLevel = 'slate' | 'amber' | 'red'

export function weightVarianceUiLevel(absPercent: number): WeightVarianceUiLevel {
  if (!Number.isFinite(absPercent) || absPercent < 0.5) return 'slate'
  if (absPercent <= 1.5) return 'amber'
  return 'red'
}

export function computeNetReceivedKg(scaleKg: number, coreKg: number): number {
  return scaleKg - coreKg
}

export function computeVarianceKg(invoiceKg: number, netReceivedKg: number): number {
  return invoiceKg - netReceivedKg
}

export function computeVariancePercent(invoiceKg: number, varianceKg: number): number | null {
  if (!Number.isFinite(invoiceKg) || invoiceKg <= 0) return null
  return (varianceKg / invoiceKg) * 100
}

export function formatDebitNoteBody(params: {
  varianceKg: number
  invoiceNumber: string
  ratePerKg: number
}): string {
  const v = Math.max(0, params.varianceKg)
  const val = v * params.ratePerKg
  return [
    `Shortage of ${v.toFixed(3)} KGs against Invoice #${params.invoiceNumber}.`,
    `Calculated Value: ₹${val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
    '',
    DEBIT_NOTE_DRAFT_SIGNATURE,
  ].join('\n')
}

export type VendorCoverage = {
  vendorPoLineId: string
  invoiceWeightKg: number
  invoiceNumber: string
  ratePerKg: number | null
}

/** Resolve vendor PO line + invoice weight for a customer PO line (board procurement). */
export async function findVendorCoverageForCustomerLine(
  db: PrismaClient,
  poLineItemId: string,
): Promise<VendorCoverage | null> {
  const lines = await db.vendorMaterialPurchaseOrderLine.findMany({
    where: {
      vendorPo: { status: { in: ['draft', 'confirmed', 'dispatched'] } },
    },
    include: { vendorPo: { select: { poNumber: true } } },
  })
  for (const ln of lines) {
    const raw = ln.linkedPoLineIds
    const ids = Array.isArray(raw) ? (raw as string[]) : []
    if (ids.includes(poLineItemId)) {
      return {
        vendorPoLineId: ln.id,
        invoiceWeightKg: Number(ln.totalWeightKg),
        invoiceNumber: ln.vendorPo.poNumber,
        ratePerKg: ln.ratePerKg != null ? Number(ln.ratePerKg) : null,
      }
    }
  }
  return null
}

export function monthlyWeightLossValueInr(varianceKg: number, ratePerKg: number | null): number {
  if (!Number.isFinite(varianceKg) || varianceKg <= 0) return 0
  const r = ratePerKg != null && Number.isFinite(ratePerKg) ? ratePerKg : 0
  return varianceKg * r
}
