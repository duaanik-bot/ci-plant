import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { createAuditLog, requireAuth } from '@/lib/helpers'
import { clampLimit, n, pageSkip, prNumber, priorityFromTrigger, sourceFromTrigger, ymd } from '@/lib/procurement-foundation'
import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

export const dynamic = 'force-dynamic'

const prSchema = z.object({
  source: z.enum(['Planning', 'Warehouse', 'Manual']).default('Manual'),
  requestedBy: z.string().trim().optional(),
  department: z.string().trim().optional(),
  requiredDate: z.string().optional(),
  priority: z.enum(['Critical', 'High', 'Medium', 'Low']).default('Medium'),
  remarks: z.string().trim().optional(),
  sourcePlanningId: z.string().trim().optional(),
  allowDuplicate: z.boolean().optional(),
  materialId: z.string().uuid(),
  requiredQty: z.coerce.number().positive(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const sp = req.nextUrl.searchParams
  const limit = clampLimit(sp.get('limit'))
  const skip = pageSkip(sp.get('page'), limit)
  const q = (sp.get('q') || sp.get('item') || '').trim()
  const status = (sp.get('status') || '').trim()
  const priority = (sp.get('priority') || '').trim().toLowerCase()
  const source = (sp.get('source') || '').trim().toLowerCase()
  const createdBy = (sp.get('createdBy') || '').trim()
  const requiredDate = sp.get('requiredDate')
  const where = {
    ...(status ? { status } : {}),
    ...(createdBy ? { raisedBy: { contains: createdBy, mode: 'insensitive' as const } } : {}),
    ...(requiredDate ? { requiredByDate: new Date(requiredDate) } : {}),
    ...(priority ? { triggerReason: { contains: priority, mode: 'insensitive' as const } } : {}),
    ...(source ? { triggerReason: { contains: source, mode: 'insensitive' as const } } : {}),
    ...(q
      ? {
          OR: [
            { triggerReason: { contains: q, mode: 'insensitive' as const } },
            { remarks: { contains: q, mode: 'insensitive' as const } },
            { material: { materialCode: { contains: q, mode: 'insensitive' as const } } },
            { material: { description: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  }

  const [rows, total] = await Promise.all([
    db.purchaseRequisition.findMany({
    where,
    orderBy: { raisedAt: 'desc' },
    take: limit,
    skip,
    include: {
      material: {
        select: {
          materialCode: true,
          description: true,
          unit: true,
          category: true,
          qtyAvailable: true,
          qtyReserved: true,
          shortageSheets: true,
        },
      },
      poLinks: true,
    },
  }),
    db.purchaseRequisition.count({ where }),
  ])

  return NextResponse.json({
    total,
    page: Math.floor(skip / limit) + 1,
    limit,
    rows: rows.map((r) => ({
      id: r.id,
      prNo: prNumber(r.id, r.raisedAt),
      date: ymd(r.raisedAt),
      source: sourceFromTrigger(r.triggerReason),
      items: r.material.materialCode,
      itemDescription: r.material.description,
      priority: priorityFromTrigger(r.triggerReason),
      requiredDate: ymd(r.requiredByDate),
      status: r.status,
      createdBy: r.raisedBy ?? 'System',
      qtyRequired: n(r.qtyRequired),
      uom: r.material.unit,
      currentStock: n(r.material.qtyAvailable) + n(r.material.qtyReserved),
      reservedStock: n(r.material.qtyReserved),
      availableStock: n(r.material.qtyAvailable),
      lineStatus: r.status === 'converted_to_po' ? 'Converted' : r.status === 'rejected' ? 'Cancelled' : n(r.poLinks.reduce((s, l) => s + n(l.allocatedQty), 0)) > 0 ? 'Partially Converted' : 'Open',
    })),
  })
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = prSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid PR body', issues: parsed.error.flatten() }, { status: 400 })
  }
  const data = parsed.data
  const material = await db.inventory.findUnique({ where: { id: data.materialId } })
  if (!material) return NextResponse.json({ error: 'Material not found' }, { status: 404 })
  if (data.sourcePlanningId && !data.allowDuplicate) {
    const existing = await db.purchaseRequisition.findFirst({
      where: {
        sourcePlanningId: data.sourcePlanningId,
        materialId: data.materialId,
        status: { in: ['draft', 'pending', 'approved', 'converted_to_po'] },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'PR already exists for this planning requirement', id: existing.id, prNo: prNumber(existing.id, existing.raisedAt) },
        { status: 409 },
      )
    }
  }

  const triggerReason = `${data.source} ${data.priority}${data.department ? ` ${data.department}` : ''}`.trim()
  const created = await db.$transaction(async (tx) => {
    const pr = await tx.purchaseRequisition.create({
      data: {
        materialId: data.materialId,
        qtyRequired: data.requiredQty,
        estimatedValue: data.requiredQty * n(material.weightedAvgCost),
        triggerReason,
        status: 'draft',
        raisedBy: data.requestedBy || user?.name || user?.email || 'System',
        requiredByDate: data.requiredDate ? new Date(data.requiredDate) : null,
        sourcePlanningId: data.sourcePlanningId || null,
        shortageId: data.sourcePlanningId || null,
        requiredSheets: material.unit.toLowerCase().includes('sheet') ? Math.round(data.requiredQty) : null,
        boardType: normalizeBoardTypeForStorage(material.boardType),
        sizeLabel:
          material.sheetLength != null && material.sheetWidth != null
            ? `${Number(material.sheetLength)} x ${Number(material.sheetWidth)}`
            : null,
        gsm: material.gsm,
        remarks: data.remarks || null,
      },
      include: { material: true },
    })
    if (data.sourcePlanningId) {
      await tx.materialShortage.updateMany({
        where: { id: data.sourcePlanningId, purchaseReqId: null },
        data: { purchaseReqId: pr.id },
      })
    }
    return pr
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'purchase_requisitions',
    recordId: created.id,
    newValue: { event: 'PR_CREATED', source: data.source, priority: data.priority, materialId: data.materialId, qty: data.requiredQty },
  })

  return NextResponse.json({ id: created.id, prNo: prNumber(created.id, created.raisedAt) }, { status: 201 })
}
