import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function DELETE(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const pr = await db.purchaseRequisition.findUnique({ where: { id } })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })

  await db.$transaction(async (tx) => {
    if (pr.status === 'converted_to_po') {
      const inv = await tx.inventory.findUnique({
        where: { id: pr.materialId },
        select: { qtyQuarantine: true },
      })
      if (inv) {
        const nextIncoming = Math.max(0, Number(inv.qtyQuarantine) - Number(pr.qtyRequired))
        await tx.inventory.update({
          where: { id: pr.materialId },
          data: { qtyQuarantine: nextIncoming },
        })
      }
    }

    await tx.materialShortage.updateMany({
      where: { purchaseReqId: pr.id },
      data: { purchaseReqId: null },
    })

    await tx.purchaseRequisition.delete({ where: { id: pr.id } })
  })

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'purchase_requisitions',
    recordId: pr.id,
    oldValue: {
      status: pr.status,
      materialId: pr.materialId,
      qtyRequired: Number(pr.qtyRequired),
    },
    newValue: { deleted: true },
  })

  return NextResponse.json({ success: true })
}

const editSchema = z.object({
  materialId: z.string().uuid().optional(),
  boardType: z.string().max(120).nullable().optional(),
  gsm: z.number().int().positive().nullable().optional(),
  sizeLabel: z.string().max(80).nullable().optional(),
  qtyRequired: z.number().positive().optional(),
  requiredByDate: z.string().datetime().nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  remarks: z.string().max(2000).nullable().optional(),
})

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const parsed = editSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const pr = await db.purchaseRequisition.findUnique({ where: { id } })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })
  if (pr.status !== 'pending') {
    return NextResponse.json({ error: 'Only draft (pending) PRs can be edited' }, { status: 400 })
  }

  if (parsed.data.materialId) {
    const inv = await db.inventory.findUnique({ where: { id: parsed.data.materialId } })
    if (!inv) return NextResponse.json({ error: 'Material not found' }, { status: 404 })
  }

  const data = parsed.data
  const updateData: Record<string, unknown> = {}
  const changedFields: Array<{ field: string; oldValue: unknown; newValue: unknown }> = []

  const track = (field: string, oldVal: unknown, newVal: unknown, key: string) => {
    if (newVal === undefined) return
    if (String(oldVal ?? '') === String(newVal ?? '')) return
    updateData[key] = newVal
    changedFields.push({ field, oldValue: oldVal ?? null, newValue: newVal ?? null })
  }

  track('Material', pr.materialId, data.materialId, 'materialId')
  track('Board Type', pr.boardType, data.boardType, 'boardType')
  track('GSM', pr.gsm, data.gsm, 'gsm')
  track('Sheet Size', pr.sizeLabel, data.sizeLabel, 'sizeLabel')
  track('Required Qty', Number(pr.qtyRequired), data.qtyRequired, 'qtyRequired')
  track('Required Date', pr.requiredByDate?.toISOString() ?? null, data.requiredByDate ?? null, 'requiredByDate')
  track('Vendor', pr.supplierId, data.supplierId, 'supplierId')
  track('Remarks', pr.remarks, data.remarks, 'remarks')

  if (changedFields.length === 0) {
    return NextResponse.json({ success: true, unchanged: true })
  }

  if (updateData.requiredByDate) updateData.requiredByDate = new Date(updateData.requiredByDate as string)

  const updated = await db.purchaseRequisition.update({ where: { id }, data: updateData })

  for (const c of changedFields) {
    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'purchase_requisitions',
      recordId: id,
      oldValue: { field: c.field, value: c.oldValue },
      newValue: { field: c.field, value: c.newValue },
    })
  }

  return NextResponse.json({ success: true, id: updated.id, changed: changedFields.map((c) => c.field) })
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireRole('stores', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const pr = await db.purchaseRequisition.findUnique({
    where: { id },
    include: { material: { select: { materialCode: true, description: true, unit: true } } },
  })
  if (!pr) return NextResponse.json({ error: 'PR not found' }, { status: 404 })

  const audits = await db.auditLog.findMany({
    where: { tableName: 'purchase_requisitions', recordId: id, action: 'UPDATE' },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, userId: true, oldValue: true, newValue: true },
  })

  const revisions = audits
    .map((a, idx) => {
      const nv = (a.newValue as Record<string, unknown> | null) || {}
      const ov = (a.oldValue as Record<string, unknown> | null) || {}
      if (typeof nv.field !== 'string') return null
      return {
        revision: idx + 1,
        at: a.timestamp.toISOString(),
        userId: a.userId ?? null,
        field: nv.field as string,
        oldValue: ov.value ?? null,
        newValue: nv.value ?? null,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  const shortages = await db.materialShortage.findMany({
    where: { purchaseReqId: id },
    select: { jobCardId: true, requiredByDate: true, remainingQty: true, shortageQty: true },
  })
  const jobIds = Array.from(new Set(shortages.map((s) => s.jobCardId).filter((v): v is string => !!v)))
  const jobCards = jobIds.length
    ? await db.productionJobCard.findMany({ where: { id: { in: jobIds } }, select: { id: true, jobCardNumber: true } })
    : []
  const jobMap = new Map(jobCards.map((j) => [j.id, j]))
  const reservations = shortages.map((s) => ({
    jobCardId: s.jobCardId ?? null,
    jobCardNumber: s.jobCardId ? (jobMap.get(s.jobCardId)?.jobCardNumber ?? null) : null,
    requiredByDate: s.requiredByDate ? s.requiredByDate.toISOString() : null,
    requiredQty: Number(s.shortageQty),
    pendingShortage: Number(s.remainingQty),
  }))
  const requiredQty = Number(pr.qtyRequired)
  const purchaseRequired = reservations.reduce((sum, r) => sum + r.pendingShortage, 0)
  const reservedQty = Math.max(0, requiredQty - purchaseRequired)

  return NextResponse.json({
    id: pr.id,
    status: pr.status,
    materialId: pr.materialId,
    material: pr.material,
    boardType: pr.boardType,
    gsm: pr.gsm,
    sizeLabel: pr.sizeLabel,
    qtyRequired: requiredQty,
    requiredByDate: pr.requiredByDate?.toISOString() ?? null,
    expectedDelivery: pr.expectedDelivery?.toISOString() ?? null,
    supplierId: pr.supplierId,
    remarks: pr.remarks,
    reservation: { requiredQty, reservedQty, purchaseRequired, links: reservations },
    revisions,
  })
}

