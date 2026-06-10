import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { clampLimit, grnNumber, grnQcLabel, n, pageSkip, ymd } from '@/lib/procurement-foundation'

export const dynamic = 'force-dynamic'

const grnSchema = z.object({
  poId: z.string().uuid(),
  supplierInvoiceNumber: z.string().optional(),
  supplierInvoiceDate: z.string().optional(),
  vehicleNumber: z.string().min(1),
  receivedDate: z.string().min(1),
  receivedBy: z.string().optional(),
  warehouse: z.string().optional(),
  remarks: z.string().optional(),
  receivingQty: z.coerce.number().positive(),
  acceptedQty: z.coerce.number().nonnegative().optional(),
  rejectedQty: z.coerce.number().nonnegative().optional(),
  rejectionReason: z.string().optional(),
  qcRemarks: z.string().optional(),
  binLocation: z.string().optional(),
  adminOverride: z.boolean().optional(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const sp = req.nextUrl.searchParams
  const limit = clampLimit(sp.get('limit'))
  const skip = pageSkip(sp.get('page'), limit)
  const q = (sp.get('q') || sp.get('poNumber') || '').trim()
  const status = (sp.get('status') || '').trim()
  const supplier = (sp.get('supplier') || '').trim()
  const qcStatus = (sp.get('qcStatus') || '').trim()
  const receivedDate = sp.get('receivedDate')
  const posted = sp.get('posted')
  const where = {
    ...(status ? { qcStatus: status } : {}),
    ...(qcStatus ? { qcStatus } : {}),
    ...(receivedDate ? { receiptDate: new Date(receivedDate) } : {}),
    ...(posted === 'true' ? { qcStatus: 'POSTED_TO_STOCK' } : posted === 'false' ? { qcStatus: { not: 'POSTED_TO_STOCK' } } : {}),
    ...(supplier ? { vendorPo: { supplier: { name: { contains: supplier, mode: 'insensitive' as const } } } } : {}),
    ...(q ? { OR: [{ scaleSlipId: { contains: q, mode: 'insensitive' as const } }, { vendorPo: { poNumber: { contains: q, mode: 'insensitive' as const } } }] } : {}),
  }
  const [rows, total] = await Promise.all([
    db.vendorMaterialReceipt.findMany({
    where,
    orderBy: { receiptDate: 'desc' },
    take: limit,
    skip,
    include: {
      vendorPo: {
        include: { supplier: { select: { name: true } }, lines: true },
      },
    },
  }),
    db.vendorMaterialReceipt.count({ where }),
  ])
  return NextResponse.json({
    total,
    page: Math.floor(skip / limit) + 1,
    limit,
    rows: rows.map((r) => {
      const orderedQty = r.vendorPo.lines.reduce((s, line) => s + n(line.totalWeightKg), 0)
      const accepted = r.qtyAcceptedStandard != null || r.qtyAcceptedPenalty != null
        ? n(r.qtyAcceptedStandard) + n(r.qtyAcceptedPenalty)
        : 0
      return {
        id: r.id,
        grnNo: grnNumber(r.id, r.receiptDate),
        poNo: r.vendorPo.poNumber,
        supplier: r.vendorPo.supplier.name,
        receivedDate: ymd(r.receiptDate),
        orderedQty,
        receivingQty: n(r.receivedQty),
        acceptedQty: accepted,
        rejectedQty: n(r.qtyRejected),
        qcStatus: grnQcLabel(accepted, n(r.qtyRejected), n(r.receivedQty), r.qcStatus),
        status: grnQcLabel(accepted, n(r.qtyRejected), n(r.receivedQty), r.qcStatus),
      }
    }),
  })
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  const parsed = grnSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid GRN body', issues: parsed.error.flatten() }, { status: 400 })
  const data = parsed.data
  const po = await db.vendorMaterialPurchaseOrder.findUnique({ where: { id: data.poId }, include: { supplier: true, lines: true } })
  if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 })
  if (po.status === 'closed' || po.status === 'cancelled') {
    return NextResponse.json({ error: 'Cannot create GRN because PO is cancelled or closed.' }, { status: 409 })
  }
  const acceptedQty = data.acceptedQty ?? 0
  const rejectedQty = data.rejectedQty ?? 0
  if (acceptedQty + rejectedQty > data.receivingQty) {
    return NextResponse.json({ error: 'Accepted + rejected quantity cannot exceed receiving quantity.' }, { status: 400 })
  }
  const ordered = po.lines.reduce((s, line) => s + n(line.totalWeightKg), 0)
  const balance = Math.max(0, ordered - n(po.totalUsableReceivedKg))
  if (!data.adminOverride && data.receivingQty > balance) {
    return NextResponse.json({ error: 'Receiving quantity cannot exceed PO balance quantity unless explicitly allowed by admin override.' }, { status: 409 })
  }

  const receipt = await db.vendorMaterialReceipt.create({
    data: {
      vendorPoId: data.poId,
      receiptDate: new Date(data.receivedDate),
      receivedQty: data.receivingQty,
      vehicleNumber: data.vehicleNumber.trim().toUpperCase(),
      scaleSlipId: data.supplierInvoiceNumber || `DRAFT-${Date.now()}`,
      receivedByUserId: user?.id,
      receivedByName: data.receivedBy || user?.name || 'Procurement',
      qtyAcceptedStandard: data.acceptedQty ?? null,
      qtyAcceptedPenalty: 0,
      qtyRejected: data.rejectedQty ?? null,
      rejectionReason: data.rejectionReason || null,
      qcStatus: 'DRAFT',
      qcRemarks: [data.remarks, data.qcRemarks, data.warehouse ? `Warehouse: ${data.warehouse}` : null, data.binLocation ? `Bin: ${data.binLocation}` : null]
        .filter(Boolean)
        .join(' | ') || null,
    },
  })
  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'vendor_material_receipts',
    recordId: receipt.id,
    newValue: { event: 'GRN_CREATED', poNumber: po.poNumber, receivingQty: data.receivingQty, status: 'DRAFT' },
  })
  return NextResponse.json({ id: receipt.id, grnNo: grnNumber(receipt.id, receipt.receiptDate) }, { status: 201 })
}
