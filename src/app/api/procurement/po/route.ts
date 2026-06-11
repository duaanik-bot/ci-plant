import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { clampLimit, n, nextVendorPoNumber, pageSkip, poOperationalStatus, ymd } from '@/lib/procurement-foundation'
import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

export const dynamic = 'force-dynamic'

const poSchema = z.object({
  supplierId: z.string().uuid(),
  prId: z.string().uuid().optional(),
  prIds: z.array(z.string().uuid()).optional(),
  expectedDeliveryDate: z.string().optional(),
  paymentTerms: z.string().optional(),
  deliveryTerms: z.string().optional(),
  buyer: z.string().optional(),
  remarks: z.string().optional(),
  item: z.string().min(1).optional(),
  description: z.string().optional(),
  quantity: z.coerce.number().positive().optional(),
  uom: z.string().optional(),
  rate: z.coerce.number().nonnegative().optional(),
  tax: z.coerce.number().nonnegative().optional(),
  lines: z.array(z.object({
    item: z.string().min(1),
    description: z.string().optional(),
    quantity: z.coerce.number().positive(),
    rate: z.coerce.number().nonnegative().default(0),
    tax: z.coerce.number().nonnegative().default(0),
    expectedDeliveryDate: z.string().optional(),
  })).optional(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const sp = req.nextUrl.searchParams
  const limit = clampLimit(sp.get('limit'))
  const skip = pageSkip(sp.get('page'), limit)
  const q = (sp.get('q') || sp.get('item') || '').trim()
  const status = (sp.get('status') || '').trim()
  const supplier = (sp.get('supplier') || '').trim()
  const expectedDelivery = sp.get('expectedDelivery')
  const overdueOnly = sp.get('overdueOnly') === 'true'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const where = {
    ...(status ? { status } : {}),
    ...(supplier ? { supplier: { name: { contains: supplier, mode: 'insensitive' as const } } } : {}),
    ...(expectedDelivery ? { requiredDeliveryDate: new Date(expectedDelivery) } : {}),
    ...(overdueOnly ? { requiredDeliveryDate: { lt: today }, status: { in: ['confirmed', 'sent', 'partial_received'] } } : {}),
    ...(q ? { OR: [{ poNumber: { contains: q, mode: 'insensitive' as const } }, { lines: { some: { boardGrade: { contains: q, mode: 'insensitive' as const } } } }] } : {}),
  }

  const [rows, total] = await Promise.all([
    db.vendorMaterialPurchaseOrder.findMany({
    where,
    orderBy: { orderDate: 'desc' },
    take: limit,
    skip,
    include: { supplier: true, lines: true, receipts: true },
  }),
    db.vendorMaterialPurchaseOrder.count({ where }),
  ])

  return NextResponse.json({
    total,
    page: Math.floor(skip / limit) + 1,
    limit,
    rows: rows.map((po) => {
      const orderedKg = po.lines.reduce((s, line) => s + n(line.totalWeightKg), 0)
      const value = po.lines.reduce((s, line) => s + n(line.totalWeightKg) * n(line.ratePerKg), 0)
      const receivedPct = orderedKg > 0 ? Math.min(100, (n(po.totalUsableReceivedKg) / orderedKg) * 100) : 0
      return {
        id: po.id,
        poNo: po.poNumber,
        supplier: po.supplier.name,
        date: ymd(po.orderDate),
        expectedDelivery: ymd(po.requiredDeliveryDate),
        items: po.lines.length,
        value,
        receivedPct,
        status: poOperationalStatus(po.status),
      }
    }),
  })
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  const parsed = poSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid PO body', issues: parsed.error.flatten() }, { status: 400 })

  const data = parsed.data
  const supplier = await db.supplier.findFirst({ where: { id: data.supplierId, active: true } })
  if (!supplier) return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })

  const currentYearPrefix = `CI-VPO-${new Date().getFullYear()}-`
  const last = await db.vendorMaterialPurchaseOrder.findFirst({
    where: { poNumber: { startsWith: currentYearPrefix } },
    orderBy: { poNumber: 'desc' },
    select: { poNumber: true },
  })
  const poNumber = nextVendorPoNumber(last?.poNumber ?? null)
  const prIds = Array.from(new Set([...(data.prIds ?? []), ...(data.prId ? [data.prId] : [])]))
  const prs = prIds.length
    ? await db.purchaseRequisition.findMany({ where: { id: { in: prIds } }, include: { material: true, poLinks: true } })
    : []
  if (prIds.length && prs.length !== prIds.length) return NextResponse.json({ error: 'Approved PR not found' }, { status: 404 })
  const invalidPr = prs.find((pr) => pr.status !== 'approved')
  if (invalidPr) return NextResponse.json({ error: 'Cannot convert PR because it is not approved.' }, { status: 409 })
  const duplicatePr = prs.find((pr) => pr.poLinks.length > 0 || pr.poReference)
  if (duplicatePr) return NextResponse.json({ error: 'PR is already linked to a PO and cannot be converted again.' }, { status: 409 })

  const lineItems = prs.length
    ? prs.map((pr) => ({
        boardGrade: normalizeBoardTypeForStorage(pr.material.boardType) || pr.material.materialCode,
        gsm: pr.material.gsm ?? 0,
        totalSheets: Math.max(1, Math.round(n(pr.qtyRequired))),
        totalWeightKg: Math.max(0.001, n(pr.qtyRequired)),
        ratePerKg: data.rate ?? n(pr.material.weightedAvgCost),
        linkedPoLineIds: [{ prId: pr.id, materialId: pr.materialId, materialCode: pr.material.materialCode, source: 'procurement_pr' }],
      }))
    : (data.lines?.length ? data.lines : [{ item: data.item || 'Manual Item', description: data.description, quantity: data.quantity ?? 1, rate: data.rate ?? 0, tax: data.tax ?? 0 }]).map((line) => ({
        boardGrade: normalizeBoardTypeForStorage(line.item) || line.item,
        gsm: 0,
        totalSheets: Math.max(1, Math.round(line.quantity)),
        totalWeightKg: Math.max(0.001, line.quantity),
        ratePerKg: line.rate ?? 0,
        linkedPoLineIds: [{ source: 'manual_procurement', description: line.description ?? line.item, tax: line.tax ?? 0, expectedDeliveryDate: line.expectedDeliveryDate ?? data.expectedDeliveryDate ?? null }],
      }))

  const created = await db.$transaction(async (tx) => {
    const po = await tx.vendorMaterialPurchaseOrder.create({
      data: {
        poNumber,
        supplierId: data.supplierId,
        status: 'draft',
        requiredDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : null,
        paymentTerms: data.paymentTerms || supplier.paymentTerms || null,
        transportTerms: data.deliveryTerms || null,
        signatoryName: data.buyer || user?.name || 'Buyer',
        remarks: data.remarks || null,
        purchaseRequisitionId: prs[0]?.id ?? null,
        materialId: prs[0]?.materialId ?? null,
        createdBy: user!.id,
        lines: { create: lineItems },
      },
    })
    for (const pr of prs) {
      await tx.purchaseRequisition.update({ where: { id: pr.id }, data: { status: 'converted_to_po', poReference: po.poNumber } })
      await tx.vendorPoRequisitionLink.create({ data: { vendorPoId: po.id, purchaseRequisitionId: pr.id, allocatedQty: n(pr.qtyRequired) } })
    }
    return po
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'vendor_material_purchase_orders',
    recordId: created.id,
    newValue: { event: 'PO_CREATED', poNumber, supplierId: data.supplierId, prIds },
  })

  return NextResponse.json({ id: created.id, poNo: created.poNumber }, { status: 201 })
}
