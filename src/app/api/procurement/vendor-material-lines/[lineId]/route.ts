import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { computeLandedRatePerKg } from '@/lib/total-landed-cost'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  freightTotalInr: z.number().nonnegative(),
  unloadingChargesInr: z.number().nonnegative(),
  insuranceMiscInr: z.number().nonnegative(),
})

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ lineId: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { lineId } = await context.params

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const existing = await db.vendorMaterialPurchaseOrderLine.findUnique({
    where: { id: lineId },
    include: { vendorPo: { select: { id: true, poNumber: true } } },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const basic =
    existing.ratePerKg != null && Number.isFinite(Number(existing.ratePerKg))
      ? Number(existing.ratePerKg)
      : null
  if (basic == null || basic < 0) {
    return NextResponse.json({ error: 'Line has no basic rate (₹/kg) set' }, { status: 409 })
  }

  const w = Number(existing.totalWeightKg)
  if (!Number.isFinite(w) || w <= 0) {
    return NextResponse.json({ error: 'Invalid line weight' }, { status: 409 })
  }

  const { freightTotalInr, unloadingChargesInr, insuranceMiscInr } = parsed.data

  const landedRatePerKg = computeLandedRatePerKg({
    basicRatePerKg: basic,
    totalWeightKg: w,
    freightTotalInr,
    unloadingChargesInr,
    insuranceMiscInr,
  })

  const updated = await db.vendorMaterialPurchaseOrderLine.update({
    where: { id: lineId },
    data: {
      freightTotalInr,
      unloadingChargesInr,
      insuranceMiscInr,
      landedRatePerKg,
    },
    select: {
      id: true,
      vendorPoId: true,
      boardGrade: true,
      gsm: true,
      totalWeightKg: true,
      ratePerKg: true,
      freightTotalInr: true,
      unloadingChargesInr: true,
      insuranceMiscInr: true,
      landedRatePerKg: true,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'vendor_material_po_lines',
    recordId: lineId,
    newValue: {
      landedRatePerKg,
      freightTotalInr,
      unloadingChargesInr,
      insuranceMiscInr,
      vendorPoNumber: existing.vendorPo.poNumber,
    },
  })

  return NextResponse.json(updated)
}
