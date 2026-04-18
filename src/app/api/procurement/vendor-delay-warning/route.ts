import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, sendWhatsApp } from '@/lib/helpers'
import { sendProcurementTextEmail } from '@/lib/procurement-dispatch-email'
import { logCommunication } from '@/lib/communication-log'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import { DELAY_WARNING_ACTIONED_BY } from '@/lib/procurement-lead-buffer'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  vendorPoId: z.string().uuid(),
  customerName: z.string().min(1).max(240),
})

function buildDelayMessage(customerName: string, vendorPoNumber: string): string {
  return `URGENT: Material for ${customerName} is at risk. Confirm dispatch for PO #${vendorPoNumber} immediately.`
}

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
  if (!vpo) {
    return NextResponse.json({ error: 'Vendor PO not found' }, { status: 404 })
  }

  const msg = buildDelayMessage(customerName.trim(), vpo.poNumber)
  const emailTo = vpo.supplier.email?.trim()
  const waTo = vpo.supplier.contactPhone?.trim()

  let emailResult: 'sent' | 'failed' | 'skipped' = 'skipped'
  if (emailTo) {
    const er = await sendProcurementTextEmail({
      to: emailTo,
      subject: `URGENT — Material at risk — ${vpo.poNumber}`,
      textBody: `${msg}\n\n— ${DELAY_WARNING_ACTIONED_BY}`,
    })
    emailResult = er.ok ? 'sent' : 'failed'
  }

  let waOk = false
  if (waTo) {
    waOk = await sendWhatsApp(waTo, `${msg}\n\n— ${DELAY_WARNING_ACTIONED_BY}`)
  }

  await logCommunication({
    channel: 'email',
    subject: `URGENT — Material at risk — ${vpo.poNumber}`,
    bodyPreview: msg,
    toAddress: emailTo ?? undefined,
    status: emailResult === 'sent' ? 'sent' : emailTo ? 'failed' : 'skipped',
    metadata: { vendorPoId, kind: 'delay_warning' },
    relatedTable: 'vendor_material_purchase_orders',
    relatedId: vendorPoId,
    actorLabel: DELAY_WARNING_ACTIONED_BY,
    userId: user!.id,
  })

  await logCommunication({
    channel: 'whatsapp',
    bodyPreview: msg,
    toAddress: waTo ?? undefined,
    status: waOk ? 'sent' : waTo ? 'failed' : 'skipped',
    metadata: { vendorPoId, kind: 'delay_warning' },
    relatedTable: 'vendor_material_purchase_orders',
    relatedId: vendorPoId,
    actorLabel: DELAY_WARNING_ACTIONED_BY,
    userId: user!.id,
  })

  await logIndustrialStatusChange({
    userId: user!.id ?? '',
    action: 'vendor_delay_warning_sent',
    module: 'VendorMaterialPO',
    recordId: vendorPoId,
    operatorLabel: DELAY_WARNING_ACTIONED_BY,
    payload: {
      vendorPoNumber: vpo.poNumber,
      customerName: customerName.trim(),
      email: emailResult,
      whatsapp: waOk ? 'sent' : waTo ? 'failed' : 'skipped',
      factoryTimeZone: 'Asia/Kolkata',
    },
  })

  return NextResponse.json({
    ok: true,
    email: emailResult,
    whatsapp: waOk ? 'sent' : waTo ? 'failed' : 'skipped',
    message: msg,
  })
}
