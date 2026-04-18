import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import { isVendorPoPostDispatchReceiving } from '@/lib/vendor-po-post-dispatch'
import { PROCUREMENT_SHORTAGE_AWAITING_REPLACEMENT } from '@/lib/vendor-po-shortage'
import { vendorPoHasReceiptRejectKg } from '@/lib/vendor-po-shortage-reject'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  rejectKg: z.coerce.number().positive(),
  replacementEtaAt: z.string().min(1),
})

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id: vendorPoId } = await context.params

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const eta = new Date(parsed.data.replacementEtaAt)
  if (Number.isNaN(eta.getTime())) {
    return NextResponse.json({ error: 'Invalid replacement ETA date' }, { status: 400 })
  }

  const vpo = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id: vendorPoId },
    select: { id: true, poNumber: true, status: true, isShortClosed: true, supplier: { select: { name: true } } },
  })
  if (!vpo) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (vpo.isShortClosed || vpo.status === 'closed') {
    return NextResponse.json({ error: 'PO is closed' }, { status: 400 })
  }
  if (!isVendorPoPostDispatchReceiving(vpo.status)) {
    return NextResponse.json(
      { error: 'Replacement flag only after mill dispatch / receiving' },
      { status: 400 },
    )
  }

  const rejectKg = parsed.data.rejectKg
  const okKg = await vendorPoHasReceiptRejectKg(db, vendorPoId, rejectKg)
  if (!okKg) {
    return NextResponse.json(
      { error: 'rejectKg does not match any GRN rejected tranche on this PO' },
      { status: 400 },
    )
  }

  const actorName = user!.name?.trim() || 'User'
  const auditMessage = `Shortage of ${rejectKg} kg handled via Request Replacement by ${actorName}.`

  await db.vendorMaterialPurchaseOrder.update({
    where: { id: vendorPoId },
    data: {
      procurementShortageFlag: PROCUREMENT_SHORTAGE_AWAITING_REPLACEMENT,
      replacementEtaAt: eta,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'vendor_material_purchase_orders',
    recordId: vendorPoId,
    newValue: {
      procurementShortageFlag: PROCUREMENT_SHORTAGE_AWAITING_REPLACEMENT,
      replacementEtaAt: eta.toISOString(),
      rejectKg,
      message: auditMessage,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'vendor_po_shortage_replacement_committed',
    module: 'VendorMaterialPO',
    recordId: vendorPoId,
    operatorLabel: actorName,
    payload: {
      poNumber: vpo.poNumber,
      supplierName: vpo.supplier.name,
      rejectKg,
      replacementEtaAtIso: eta.toISOString(),
      auditMessage,
    },
  })

  return NextResponse.json({
    ok: true,
    procurementShortageFlag: PROCUREMENT_SHORTAGE_AWAITING_REPLACEMENT,
    replacementEtaAt: eta.toISOString(),
    message: auditMessage,
  })
}
