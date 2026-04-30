import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const UNITS = ['sheets', 'packets', 'kg', 'grs', 'tonnes', 'litres', 'metres', 'pieces'] as const

const updateSchema = z.object({
  materialCode: z.string().min(1).optional(),
  description: z.string().optional(),
  unit: z.enum(UNITS).optional(),
  reorderPoint: z.number().min(0).optional(),
  safetyStock: z.number().min(0).optional(),
  storageLocation: z.string().optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  supplierId: z.string().uuid().optional().nullable(),
  weightedAvgCost: z.number().min(0).optional(),
  active: z.boolean().optional(),
  boardType: z.string().optional().nullable(),
  gsm: z.number().int().positive().optional().nullable(),
  sheetLength: z.number().positive().optional().nullable(),
  sheetWidth: z.number().positive().optional().nullable(),
  grainDirection: z.string().optional().nullable(),
  caliperMicrons: z.number().positive().optional().nullable(),
  brightnessPct: z.number().min(0).max(100).optional().nullable(),
  moisturePct: z.number().min(0).max(100).optional().nullable(),
  hsnCode: z.string().optional().nullable(),
})

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const m = await db.inventory.findUnique({
    where: { id },
    include: { supplier: { select: { id: true, name: true } } },
  })
  if (!m) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    id: m.id,
    materialCode: m.materialCode,
    description: m.description,
    unit: m.unit,
    qtyQuarantine: Number(m.qtyQuarantine),
    qtyAvailable: Number(m.qtyAvailable),
    qtyReserved: Number(m.qtyReserved),
    qtyFg: Number(m.qtyFg),
    weightedAvgCost: Number(m.weightedAvgCost),
    reorderPoint: Number(m.reorderPoint),
    safetyStock: Number(m.safetyStock),
    active: m.active,
    storageLocation: m.storageLocation,
    leadTimeDays: m.leadTimeDays,
    boardType: null,
    gsm: null,
    sheetLength: null,
    sheetWidth: null,
    grainDirection: null,
    caliperMicrons: null,
    brightnessPct: null,
    moisturePct: null,
    hsnCode: null,
    supplier: m.supplier ? { id: m.supplier.id, name: m.supplier.name } : null,
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    reorderPoint: toOptionalNumber(body.reorderPoint),
    safetyStock: toOptionalNumber(body.safetyStock),
    leadTimeDays: toOptionalNumber(body.leadTimeDays),
    weightedAvgCost: toOptionalNumber(body.weightedAvgCost),
    supplierId: body.supplierId === '' ? null : body.supplierId,
    gsm: toOptionalNumber(body.gsm),
    sheetLength: toOptionalNumber(body.sheetLength),
    sheetWidth: toOptionalNumber(body.sheetWidth),
    caliperMicrons: toOptionalNumber(body.caliperMicrons),
    brightnessPct: toOptionalNumber(body.brightnessPct),
    moisturePct: toOptionalNumber(body.moisturePct),
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.inventory.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const data = parsed.data
  if (data.materialCode != null) {
    const duplicate = await db.inventory.findFirst({
      where: { materialCode: data.materialCode, id: { not: id } },
    })
    if (duplicate) {
      return NextResponse.json(
        { error: 'Material code already exists', fields: { materialCode: 'Material code already exists' } },
        { status: 400 },
      )
    }
  }

  const material = await db.inventory.update({
    where: { id },
    data: {
      ...(data.materialCode != null && { materialCode: data.materialCode.trim() }),
      ...(data.description != null && data.description.trim().length > 0 && { description: data.description.trim() }),
      ...(data.unit != null && { unit: data.unit }),
      ...(data.reorderPoint != null && { reorderPoint: data.reorderPoint }),
      ...(data.safetyStock != null && { safetyStock: data.safetyStock }),
      ...(data.storageLocation !== undefined && { storageLocation: data.storageLocation || null }),
      ...(data.leadTimeDays != null && { leadTimeDays: data.leadTimeDays }),
      ...(data.supplierId !== undefined && { supplierId: data.supplierId }),
      ...(data.weightedAvgCost != null && { weightedAvgCost: data.weightedAvgCost }),
      ...(data.active !== undefined && { active: data.active }),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'inventory',
    recordId: id,
    oldValue: existing,
    newValue: material,
  })

  return NextResponse.json(material)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const existing = await db.inventory.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  await db.inventory.delete({ where: { id } })

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'inventory',
    recordId: id,
    oldValue: { materialCode: existing.materialCode, description: existing.description },
  })

  return NextResponse.json({ ok: true })
}
