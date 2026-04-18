import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireRole } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import { isVendorPoPostDispatchReceiving } from '@/lib/vendor-po-post-dispatch'
import {
  computeShortCloseSnapshot,
  netReceivedKgByVendorLineId,
  SHORT_CLOSE_EXECUTOR_ROLES,
  SHORT_CLOSE_REASONS,
} from '@/lib/vendor-po-short-close'
import { vendorPoHasReceiptRejectKg } from '@/lib/vendor-po-shortage-reject'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  reason: z.enum(SHORT_CLOSE_REASONS),
  remarks: z.string().trim().min(10).max(4000),
  /** When true, skips 95% gate — requires matching GRN reject kg (shortage modal). */
  rejectionShortClose: z.boolean().optional(),
  rejectKg: z.coerce.number().positive().optional(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole(...SHORT_CLOSE_EXECUTOR_ROLES)
  if (error) return error
  const { id } = await context.params

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body — remarks must be at least 10 characters' }, { status: 400 })
  }

  const vpo = await db.vendorMaterialPurchaseOrder.findUnique({
    where: { id },
    include: { lines: true, supplier: true },
  })
  if (!vpo) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!isVendorPoPostDispatchReceiving(vpo.status)) {
    return NextResponse.json(
      { error: 'Only mill-dispatched / in-receipt vendor POs can be short-closed' },
      { status: 400 },
    )
  }
  if (vpo.isShortClosed) {
    return NextResponse.json({ error: 'Already short-closed' }, { status: 409 })
  }

  const lineIds = vpo.lines.map((l) => l.id)
  const receivedByLine = await netReceivedKgByVendorLineId(db, lineIds)
  const snap = computeShortCloseSnapshot(vpo, receivedByLine)
  const rejectionShortClose = parsed.data.rejectionShortClose === true
  const rejectKg = parsed.data.rejectKg

  if (rejectionShortClose) {
    if (rejectKg == null) {
      return NextResponse.json({ error: 'rejectKg required for rejection short-close' }, { status: 400 })
    }
    const okKg = await vendorPoHasReceiptRejectKg(db, id, rejectKg)
    if (!okKg) {
      return NextResponse.json(
        { error: 'rejectKg does not match any GRN rejected tranche on this PO' },
        { status: 400 },
      )
    }
    if (parsed.data.reason !== 'Rejection shortage — short-close') {
      return NextResponse.json(
        { error: 'Rejection short-close must use reason "Rejection shortage — short-close"' },
        { status: 400 },
      )
    }
  } else if (!snap.eligible) {
    return NextResponse.json(
      {
        error: 'Not authorized to short-close — completion below 95% threshold',
        completionPct: snap.completionPct,
        orderedKg: snap.orderedKg,
        receivedKg: snap.receivedKg,
      },
      { status: 400 },
    )
  }

  const reason = parsed.data.reason
  const remarks = parsed.data.remarks
  const actorName = user!.name?.trim() || 'User'
  const auditMessage = rejectionShortClose
    ? `Shortage of ${rejectKg} kg handled via Short-Close Balance by ${actorName}. Remarks: ${remarks}`
    : `PO Short-Closed by ${actorName}. Reason: ${reason}. Remarks: ${remarks}.`
  const now = new Date()

  await db.vendorMaterialPurchaseOrder.update({
    where: { id },
    data: {
      status: 'closed',
      isShortClosed: true,
      shortCloseReason: reason,
      shortCloseRemarks: remarks,
      shortClosedAt: now,
      shortClosedByUserId: user!.id,
      shortClosedByName: actorName,
      shortCloseCompletionPct: snap.completionPct,
      procurementShortageFlag: null,
      replacementEtaAt: null,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'vendor_material_purchase_orders',
    recordId: id,
    newValue: {
      status: 'closed',
      isShortClosed: true,
      shortCloseReason: reason,
      shortCloseRemarks: remarks,
      shortCloseCompletionPct: snap.completionPct,
      message: auditMessage,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'vendor_po_short_closed',
    module: 'VendorMaterialPO',
    recordId: id,
    operatorLabel: actorName,
    payload: {
      poNumber: vpo.poNumber,
      supplierName: vpo.supplier.name,
      completionPct: snap.completionPct,
      reason,
      remarks,
      rejectionShortClose,
      rejectKg: rejectKg ?? null,
      auditMessage,
      timestampIso: now.toISOString(),
    },
  })

  return NextResponse.json({
    ok: true,
    completionPct: snap.completionPct,
    orderedKg: snap.orderedKg,
    receivedKg: snap.receivedKg,
    message: auditMessage,
  })
}
