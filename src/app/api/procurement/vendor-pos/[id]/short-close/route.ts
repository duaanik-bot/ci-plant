import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireRole } from '@/lib/helpers'
import { logIndustrialStatusChange } from '@/lib/industrial-audit'
import {
  computeShortCloseSnapshot,
  netReceivedKgByVendorLineId,
  SHORT_CLOSE_EXECUTOR_ROLES,
  SHORT_CLOSE_REASONS,
} from '@/lib/vendor-po-short-close'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  reason: z.enum(SHORT_CLOSE_REASONS),
  remarks: z.string().trim().min(10).max(4000),
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
  if (vpo.status !== 'dispatched') {
    return NextResponse.json({ error: 'Only dispatched vendor POs can be short-closed' }, { status: 400 })
  }
  if (vpo.isShortClosed) {
    return NextResponse.json({ error: 'Already short-closed' }, { status: 409 })
  }

  const lineIds = vpo.lines.map((l) => l.id)
  const receivedByLine = await netReceivedKgByVendorLineId(db, lineIds)
  const snap = computeShortCloseSnapshot(vpo, receivedByLine)
  if (!snap.eligible) {
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
  const auditMessage = `PO Short-Closed by ${actorName}. Reason: ${reason}. Remarks: ${remarks}.`
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
