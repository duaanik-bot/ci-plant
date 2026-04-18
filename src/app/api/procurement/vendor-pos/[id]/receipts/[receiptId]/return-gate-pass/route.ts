import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { INDUSTRIAL_DEFAULT_OPERATOR, logIndustrialStatusChange } from '@/lib/industrial-audit'
import { buildGrnReturnGatePassHtml } from '@/lib/grn-return-gate-pass-html'

export const dynamic = 'force-dynamic'

/**
 * POST: audit + stamp generation time, return printable HTML for rejected material return.
 */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string; receiptId: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id: vendorPoId, receiptId } = await context.params

  const receipt = await db.vendorMaterialReceipt.findFirst({
    where: { id: receiptId, vendorPoId },
    include: { vendorPo: { select: { poNumber: true, transporterName: true } } },
  })
  if (!receipt) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })

  const rej = receipt.qtyRejected != null ? Number(receipt.qtyRejected) : 0
  if (!(rej > 0)) {
    return NextResponse.json({ error: 'No rejected quantity on this receipt' }, { status: 400 })
  }

  const operatorName = (user!.name?.trim() || INDUSTRIAL_DEFAULT_OPERATOR).trim()
  const now = new Date()

  await db.vendorMaterialReceipt.update({
    where: { id: receiptId },
    data: { returnGatePassGeneratedAt: now },
  })

  const vehicle = receipt.vehicleNumber.trim()
  const auditMessage = `Material Rejected & Returned via ${vehicle} - Actioned by ${operatorName}.`

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'vendor_material_receipts',
    recordId: receiptId,
    newValue: {
      returnGatePassGeneratedAt: now.toISOString(),
      returnQtyKg: rej,
      vehicleNumber: vehicle,
      message: auditMessage,
    },
  })

  await logIndustrialStatusChange({
    userId: user!.id,
    action: 'vendor_material_return_gate_pass',
    module: 'VendorMaterialPO',
    recordId: vendorPoId,
    operatorLabel: operatorName,
    payload: {
      receiptId,
      poNumber: receipt.vendorPo.poNumber,
      vehicleNumber: vehicle,
      returnQtyKg: rej,
      auditMessage,
      timestampIso: now.toISOString(),
    },
  })

  const html = buildGrnReturnGatePassHtml({
    poNumber: receipt.vendorPo.poNumber,
    scaleSlipId: receipt.scaleSlipId,
    vehicleNumber: vehicle,
    transporterName: receipt.vendorPo.transporterName,
    rejectionReason: receipt.rejectionReason,
    rejectionRemarks: receipt.rejectionRemarks,
    returnQtyKg: rej,
    generatedAtIso: now.toISOString(),
    generatedByLabel: operatorName,
  })

  return NextResponse.json({
    ok: true,
    html,
    auditMessage,
  })
}
