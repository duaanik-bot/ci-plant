import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, sendWhatsApp } from '@/lib/helpers'
import { logCommunication } from '@/lib/communication-log'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import {
  effectiveLogisticsLane,
  isInTransitStale,
  PROCUREMENT_LOGISTICS_AUDIT_ACTOR,
} from '@/lib/procurement-logistics-hud'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  vendorPoId: z.string().uuid(),
  customerName: z.string().min(1).max(240),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { vendorPoId, customerName } = parsed.data

  const vpo = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id: vendorPoId },
    include: { supplier: true },
  })
  if (!vpo) return NextResponse.json({ error: 'Vendor PO not found' }, { status: 404 })

  const lane = effectiveLogisticsLane(vpo)
  if (lane !== 'in_transit') {
    return NextResponse.json({ error: 'Follow-up applies to in-transit loads only' }, { status: 400 })
  }
  if (!isInTransitStale(lane, vpo.estimatedArrivalAt)) {
    return NextResponse.json(
      { error: 'ETA is not overdue by 6h — follow-up not required yet' },
      { status: 400 },
    )
  }

  const lr = vpo.lrNumber?.trim() ?? '—'
  const vh = vpo.vehicleNumber?.trim() ?? '—'
  const eta =
    vpo.estimatedArrivalAt != null
      ? vpo.estimatedArrivalAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      : '—'

  const msg = `LOGISTICS FOLLOW-UP (in-transit overdue >6h vs ETA)
Vendor PO: ${vpo.poNumber}
Customer context: ${customerName.trim()}
Supplier: ${vpo.supplier.name}
LR: ${lr} · Vehicle: ${vh}
ETA (IST): ${eta}
— ${PROCUREMENT_LOGISTICS_AUDIT_ACTOR} · Logistics HUD`

  const managers = await db.user.findMany({
    where: {
      active: true,
      role: { roleName: { in: ['procurement_manager', 'operations_head'] } },
      whatsappNumber: { not: null },
    },
    select: { id: true, whatsappNumber: true, name: true },
  })

  let waSent = 0
  for (const m of managers) {
    if (m.whatsappNumber && (await sendWhatsApp(m.whatsappNumber, msg))) waSent += 1
  }

  await logCommunication({
    channel: 'whatsapp',
    subject: `Logistics follow-up — ${vpo.poNumber}`,
    bodyPreview: msg,
    status: waSent > 0 ? 'sent' : managers.length === 0 ? 'skipped' : 'failed',
    metadata: { vendorPoId, kind: 'logistics_intransit_followup', recipients: managers.length },
    relatedTable: 'vendor_material_purchase_orders',
    relatedId: vendorPoId,
    actorLabel: PROCUREMENT_LOGISTICS_AUDIT_ACTOR,
    userId: user!.id,
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'logistics_intransit_followup_sent',
    module: 'VendorMaterialPO',
    recordId: vendorPoId,
    operatorLabel: PROCUREMENT_LOGISTICS_AUDIT_ACTOR,
    payload: {
      vendorPoNumber: vpo.poNumber,
      customerName: customerName.trim(),
      whatsappRecipientsNotified: waSent,
      factoryTimeZone: 'Asia/Kolkata',
    },
  })

  return NextResponse.json({
    ok: true,
    whatsappSent: waSent,
    managersEligible: managers.length,
    message: msg,
  })
}
