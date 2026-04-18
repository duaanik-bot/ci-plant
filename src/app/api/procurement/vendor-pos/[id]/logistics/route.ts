import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import { PROCUREMENT_LOGISTICS_AUDIT_ACTOR } from '@/lib/procurement-logistics-hud'
import { isVendorPoPostDispatchReceiving } from '@/lib/vendor-po-post-dispatch'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  transporterName: z.string().max(200).optional().nullable(),
  lrNumber: z.string().max(120).optional().nullable(),
  vehicleNumber: z.string().max(64).optional().nullable(),
  estimatedArrivalAt: z
    .string()
    .optional()
    .nullable()
    .transform((s) => {
      if (s == null || s.trim() === '') return null
      const d = new Date(s)
      return Number.isNaN(d.getTime()) ? null : d
    }),
  logisticsStatus: z.enum(['mill_dispatched', 'in_transit', 'at_gate']).optional(),
})

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const existing = await db.vendorMaterialPurchaseOrder.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!isVendorPoPostDispatchReceiving(existing.status) || existing.isShortClosed) {
    return NextResponse.json(
      { error: 'Logistics can only be edited on active mill-dispatched / GRN-in-progress POs' },
      { status: 400 },
    )
  }

  const p = parsed.data
  const transporterName =
    p.transporterName !== undefined ? p.transporterName : existing.transporterName
  const lrNumber = p.lrNumber !== undefined ? p.lrNumber : existing.lrNumber
  const vehicleNumber = p.vehicleNumber !== undefined ? p.vehicleNumber : existing.vehicleNumber
  const estimatedArrivalAt =
    p.estimatedArrivalAt !== undefined ? p.estimatedArrivalAt : existing.estimatedArrivalAt

  const lr = lrNumber?.trim() || null
  const vh = vehicleNumber?.trim() || null

  let logisticsStatus = p.logisticsStatus
  if (logisticsStatus == null) {
    const prev = existing.logisticsStatus ?? 'mill_dispatched'
    if (prev === 'at_gate') {
      logisticsStatus = 'at_gate'
    } else if (lr && vh) {
      logisticsStatus = 'in_transit'
    } else {
      logisticsStatus = 'mill_dispatched'
    }
  }

  const now = new Date()
  const updated = await db.vendorMaterialPurchaseOrder.update({
    where: { id },
    data: {
      transporterName: transporterName?.trim() || null,
      lrNumber: lr,
      vehicleNumber: vh,
      estimatedArrivalAt,
      logisticsStatus,
      logisticsUpdatedAt: now,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'vendor_po_logistics_updated',
    module: 'VendorMaterialPO',
    recordId: id,
    operatorLabel: PROCUREMENT_LOGISTICS_AUDIT_ACTOR,
    payload: {
      poNumber: updated.poNumber,
      logisticsStatus: updated.logisticsStatus,
      timestampIso: now.toISOString(),
      transporterName: updated.transporterName,
      lrNumber: updated.lrNumber,
      vehicleNumber: updated.vehicleNumber,
      estimatedArrivalAt: updated.estimatedArrivalAt?.toISOString() ?? null,
    },
  })

  return NextResponse.json({
    ok: true,
    logistics: {
      transporterName: updated.transporterName,
      lrNumber: updated.lrNumber,
      vehicleNumber: updated.vehicleNumber,
      estimatedArrivalAt: updated.estimatedArrivalAt?.toISOString() ?? null,
      logisticsStatus: updated.logisticsStatus,
      logisticsUpdatedAt: updated.logisticsUpdatedAt?.toISOString() ?? null,
    },
  })
}
