import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import {
  computeNetReceivedKg,
  computeVarianceKg,
  computeVariancePercent,
  findVendorCoverageForCustomerLine,
} from '@/lib/weight-reconciliation'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  poLineItemId: z.string().uuid(),
  scaleWeightKg: z.number().positive(),
  coreWeightKg: z.number().nonnegative(),
  /** Optional override; defaults from vendor PO line or material queue. */
  invoiceWeightKg: z.number().positive().optional(),
})

export async function POST(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { poLineItemId, scaleWeightKg, coreWeightKg } = parsed.data

  const line = await db.poLineItem.findUnique({
    where: { id: poLineItemId },
    include: { materialQueue: true },
  })
  if (!line) {
    return NextResponse.json({ error: 'Line not found' }, { status: 404 })
  }
  if (line.materialProcurementStatus !== 'received') {
    return NextResponse.json(
      { error: 'Mark material received before entering scale weights' },
      { status: 400 },
    )
  }

  const coverage = await findVendorCoverageForCustomerLine(db, poLineItemId)
  const invoiceWeightKg =
    parsed.data.invoiceWeightKg ??
    coverage?.invoiceWeightKg ??
    (line.materialQueue ? Number(line.materialQueue.totalWeightKg) : null)

  if (invoiceWeightKg == null || !Number.isFinite(invoiceWeightKg) || invoiceWeightKg <= 0) {
    return NextResponse.json(
      { error: 'Could not resolve invoice weight — link vendor PO or material queue' },
      { status: 400 },
    )
  }

  const netReceivedKg = computeNetReceivedKg(scaleWeightKg, coreWeightKg)
  const varianceKg = computeVarianceKg(invoiceWeightKg, netReceivedKg)
  const variancePercent = computeVariancePercent(invoiceWeightKg, varianceKg)
  const rate = coverage?.ratePerKg ?? null

  const row = await db.materialWeightReconciliation.upsert({
    where: { poLineItemId },
    create: {
      poLineItemId,
      vendorMaterialPoLineId: coverage?.vendorPoLineId ?? null,
      invoiceNumber: coverage?.invoiceNumber ?? null,
      invoiceWeightKg,
      scaleWeightKg,
      coreWeightKg,
      netReceivedKg,
      varianceKg,
      variancePercent: variancePercent ?? undefined,
      ratePerKgInr: rate ?? undefined,
      reconciliationStatus: 'ok',
    },
    update: {
      vendorMaterialPoLineId: coverage?.vendorPoLineId ?? undefined,
      invoiceNumber: coverage?.invoiceNumber ?? undefined,
      invoiceWeightKg,
      scaleWeightKg,
      coreWeightKg,
      netReceivedKg,
      varianceKg,
      variancePercent: variancePercent ?? undefined,
      ratePerKgInr: rate ?? undefined,
      debitNoteDraftText: null,
      debitNoteDraftedAt: null,
      reconciliationStatus: 'ok',
    },
  })

  return NextResponse.json({
    reconciliation: {
      id: row.id,
      poLineItemId: row.poLineItemId,
      invoiceWeightKg: Number(row.invoiceWeightKg),
      scaleWeightKg: Number(row.scaleWeightKg),
      coreWeightKg: Number(row.coreWeightKg),
      netReceivedKg: Number(row.netReceivedKg),
      varianceKg: Number(row.varianceKg),
      variancePercent: row.variancePercent != null ? Number(row.variancePercent) : null,
      ratePerKgInr: row.ratePerKgInr != null ? Number(row.ratePerKgInr) : null,
      invoiceNumber: row.invoiceNumber,
      reconciliationStatus: row.reconciliationStatus,
    },
  })
}
