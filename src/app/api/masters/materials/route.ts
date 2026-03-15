import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

const UNITS = ['sheets', 'kg', 'litres', 'metres', 'pieces'] as const

const createSchema = z.object({
  materialCode: z.string().min(1, 'Material code is required'),
  description: z.string().min(1, 'Description is required'),
  unit: z.enum(UNITS),
  reorderPoint: z.number().min(0).default(0),
  safetyStock: z.number().min(0).default(0),
  storageLocation: z.string().optional(),
  leadTimeDays: z.number().int().min(0).default(7),
  supplierId: z.string().uuid().optional().nullable(),
  weightedAvgCost: z.number().min(0).default(0),
  active: z.boolean().default(true),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.inventory.findMany({
    include: { supplier: { select: { id: true, name: true } } },
    orderBy: { materialCode: 'asc' },
  })
  return NextResponse.json(list.map((m) => ({
    ...m,
    qtyQuarantine: Number(m.qtyQuarantine),
    qtyAvailable: Number(m.qtyAvailable),
    qtyReserved: Number(m.qtyReserved),
    qtyFg: Number(m.qtyFg),
    weightedAvgCost: Number(m.weightedAvgCost),
    reorderPoint: Number(m.reorderPoint),
    safetyStock: Number(m.safetyStock),
  })))
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    reorderPoint: body.reorderPoint != null ? Number(body.reorderPoint) : 0,
    safetyStock: body.safetyStock != null ? Number(body.safetyStock) : 0,
    leadTimeDays: body.leadTimeDays != null ? Number(body.leadTimeDays) : 7,
    weightedAvgCost: body.weightedAvgCost != null ? Number(body.weightedAvgCost) : 0,
    supplierId: body.supplierId || null,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.inventory.findUnique({
    where: { materialCode: parsed.data.materialCode },
  })
  if (existing) {
    return NextResponse.json(
      { error: 'Material code already exists', fields: { materialCode: 'Material code already exists' } },
      { status: 400 }
    )
  }

  const data = parsed.data
  const material = await db.inventory.create({
    data: {
      materialCode: data.materialCode.trim(),
      description: data.description.trim(),
      unit: data.unit,
      reorderPoint: data.reorderPoint,
      safetyStock: data.safetyStock,
      storageLocation: data.storageLocation || null,
      leadTimeDays: data.leadTimeDays,
      supplierId: data.supplierId || null,
      weightedAvgCost: data.weightedAvgCost,
      active: data.active,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'inventory',
    recordId: material.id,
    newValue: { materialCode: material.materialCode },
  })

  return NextResponse.json(material, { status: 201 })
}
