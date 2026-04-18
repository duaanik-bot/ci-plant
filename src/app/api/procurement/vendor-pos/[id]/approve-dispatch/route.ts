import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog, sendWhatsApp } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import { PROCUREMENT_DEFAULT_SIGNATORY } from '@/lib/procurement-mrp-service'
import { PROCUREMENT_APPROVAL_SIGNATORY } from '@/lib/material-readiness-vitals'
import { buildVendorMaterialPoPdfBuffer } from '@/lib/vendor-po-pdf'
import { sendVendorPoEmail, vendorPoEmailSubject } from '@/lib/procurement-dispatch-email'
import { logCommunication } from '@/lib/communication-log'
import { kgToMetricTons } from '@/lib/board-mrp'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  signatoryName: z.string().min(1).max(120).optional(),
  lineRates: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        ratePerKg: z.number().nonnegative().nullable(),
      }),
    )
    .optional(),
})

export async function POST(
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

  const existing = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, lines: true },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.dispatchedAt) {
    return NextResponse.json({ error: 'Already dispatched' }, { status: 409 })
  }
  if (existing.status === 'cancelled') {
    return NextResponse.json({ error: 'PO cancelled' }, { status: 400 })
  }

  const signatory = parsed.data.signatoryName?.trim() || PROCUREMENT_DEFAULT_SIGNATORY

  if (parsed.data.lineRates?.length) {
    for (const lr of parsed.data.lineRates) {
      await db.vendorMaterialPurchaseOrderLine.updateMany({
        where: { id: lr.lineId, vendorPoId: id },
        data: { ratePerKg: lr.ratePerKg == null ? null : lr.ratePerKg },
      })
    }
  }

  const fresh = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, lines: true },
  })
  if (!fresh) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const allIds = fresh.lines.flatMap((ln) => {
    const raw = ln.linkedPoLineIds
    return Array.isArray(raw) ? (raw as string[]) : []
  })
  const uniqueLineIds = Array.from(new Set(allIds))

  await db.$transaction(async (tx) => {
    await tx.vendorMaterialPurchaseOrder.update({
      where: { id },
      data: {
        status: 'dispatched',
        signatoryName: signatory,
        dispatchedAt: new Date(),
        dispatchActor: PROCUREMENT_APPROVAL_SIGNATORY,
        logisticsStatus: 'mill_dispatched',
        logisticsUpdatedAt: new Date(),
      },
    })
    await tx.poLineItem.updateMany({
      where: {
        id: { in: uniqueLineIds },
        materialProcurementStatus: { not: 'received' },
      },
      data: { materialProcurementStatus: 'on_order' },
    })
  })

  const pdfLines = fresh.lines.map((ln) => ({
    boardGrade: ln.boardGrade,
    gsm: ln.gsm,
    grainDirection: ln.grainDirection,
    totalSheets: ln.totalSheets,
    totalWeightKg: Number(ln.totalWeightKg),
    ratePerKg: ln.ratePerKg != null ? Number(ln.ratePerKg) : null,
  }))

  const totalKg = pdfLines.reduce((s, l) => s + l.totalWeightKg, 0)
  const tons = kgToMetricTons(totalKg)
  const boardTypesLabel = Array.from(new Set(pdfLines.map((l) => l.boardGrade))).join(', ')
  const pdfBuffer = buildVendorMaterialPoPdfBuffer({
    poNumber: fresh.poNumber,
    supplierName: fresh.supplier.name,
    signatoryName: signatory,
    requiredDeliveryYmd: fresh.requiredDeliveryDate
      ? fresh.requiredDeliveryDate.toISOString().slice(0, 10)
      : null,
    remarks: fresh.remarks,
    lines: pdfLines,
  })

  const subject = vendorPoEmailSubject(boardTypesLabel, fresh.poNumber)
  const emailTo = fresh.supplier.email?.trim()
  let emailResult: { ok: true } | { ok: false; error: string } = {
    ok: false,
    error: 'No supplier email',
  }
  if (emailTo) {
    emailResult = await sendVendorPoEmail({
      to: emailTo,
      subject,
      pdfBuffer,
      pdfFilename: `${fresh.poNumber.replace(/[^a-z0-9-_]/gi, '_')}.pdf`,
      textBody: `Please find attached material purchase order ${fresh.poNumber} for ${boardTypesLabel}.\n\n${signatory}\nDarbi Print Pack / Colour Impressions`,
    })
  }

  await logCommunication({
    channel: 'email',
    subject,
    bodyPreview: `Vendor PO PDF ${fresh.poNumber} · ${boardTypesLabel}`,
    toAddress: emailTo ?? undefined,
    status: emailResult.ok ? 'sent' : emailTo ? 'failed' : 'skipped',
    errorMessage: emailResult.ok ? null : 'error' in emailResult ? emailResult.error : null,
    metadata: { vendorPoId: id, poNumber: fresh.poNumber },
    relatedTable: 'vendor_material_purchase_orders',
    relatedId: id,
    actorLabel: signatory,
    userId: user!.id,
  })

  const waTo = fresh.supplier.contactPhone?.trim()
  const waMsg = `New Board Order: ${tons.toFixed(3)} tons of ${boardTypesLabel} - PO#${fresh.poNumber}.`
  let waOk = false
  if (waTo) {
    waOk = await sendWhatsApp(waTo, waMsg)
  }

  await logCommunication({
    channel: 'whatsapp',
    bodyPreview: waMsg,
    toAddress: waTo ?? undefined,
    status: waOk ? 'sent' : waTo ? 'failed' : 'skipped',
    metadata: { vendorPoId: id },
    relatedTable: 'vendor_material_purchase_orders',
    relatedId: id,
    actorLabel: signatory,
    userId: user!.id,
  })

  const updated = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id },
    include: { supplier: true, lines: true },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'vendor_material_purchase_orders',
    recordId: id,
    newValue: {
      status: 'dispatched',
      emailOk: emailResult.ok,
      whatsappOk: waOk,
      actor: signatory,
      industrialRelease: PROCUREMENT_APPROVAL_SIGNATORY,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id ?? '',
    action: 'vendor_material_order_released',
    module: 'VendorMaterialPO',
    recordId: id,
    operatorLabel: PROCUREMENT_APPROVAL_SIGNATORY,
    payload: {
      poNumber: fresh.poNumber,
      supplierId: fresh.supplierId,
      signatoryOnDocument: signatory,
    },
  })

  return NextResponse.json({
    vendorPo: updated,
    email: emailResult.ok ? 'sent' : emailTo ? 'failed' : 'skipped',
    whatsapp: waOk ? 'sent' : waTo ? 'failed' : 'skipped',
  })
}
