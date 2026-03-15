import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

const UNITS = ['sheets', 'kg', 'litres', 'metres', 'pieces'] as const

const updateSchema = z.object({
  materialCode: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  unit: z.enum(UNITS).optional(),
  reorderPoint: z.number().min(0).optional(),
  safetyStock: z.number().min(0).optional(),
  storageLocation: z.string().optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  supplierId: z.string().uuid().optional().nullable(),
  weightedAvgCost: z.number().min(0).optional(),
  active: z.boolean().optional(),
})

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    reorderPoint: body.reorderPoint != null ? Number(body.reorderPoint) : undefined,
    safetyStock: body.safetyStock != null ? Number(body.safetyStock) : undefined,
    leadTimeDays: body.leadTimeDays != null ? Number(body.leadTimeDays) : undefined,
    weightedAvgCost: body.weightedAvgCost != null ? Number(body.weightedAvgCost) : undefined,
    supplierId: body.supplierId === '' ? null : body.supplierId,
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
        { status: 400 }
      )
    }
  }

  const material = await db.inventory.update({
    where: { id },
    data: {
      ...(data.materialCode != null && { materialCode: data.materialCode.trim() }),
      ...(data.description != null && { description: data.description.trim() }),
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
