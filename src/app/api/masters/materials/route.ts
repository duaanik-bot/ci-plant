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

const BOARD_TYPE_PREFIX: Record<string, string> = {
  FBB: 'FBB',
  SAFFIRE: 'SAF',
  'WB DUplex': 'WB',
  'GB Duples': 'GB',
  CFBB: 'CFBB',
  Artcard: 'ART',
  Maplitho: 'MAP',
}

function generateMaterialCode(boardType: string, gsm?: number, sheetLength?: number, sheetWidth?: number): string {
  const prefix = BOARD_TYPE_PREFIX[boardType] ?? 'BRD'
  const parts = [prefix]
  if (gsm) parts.push(String(gsm))
  if (sheetLength && sheetWidth) parts.push(`${Math.round(sheetLength)}x${Math.round(sheetWidth)}`)
  return parts.join('-')
}

const createSchema = z.object({
  autoGenerateCode: z.boolean().default(true),
  materialCode: z.string().optional(),
  description: z.string().optional().nullable(),
  unit: z.enum(UNITS),
  reorderPoint: z.number().min(0).default(0),
  safetyStock: z.number().min(0).default(0),
  storageLocation: z.string().optional(),
  leadTimeDays: z.number().int().min(0).default(7),
  supplierId: z.string().uuid().optional().nullable(),
  weightedAvgCost: z.number().min(0).default(0),
  active: z.boolean().default(true),
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

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.inventory.findMany({
    orderBy: { materialCode: 'asc' },
    include: { supplier: { select: { id: true, name: true } } },
  })
  return NextResponse.json(
    list.map((m) => ({
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
      boardType: null,
      gsm: null,
      sheetLength: null,
      sheetWidth: null,
      brightnessPct: null,
      moisturePct: null,
      supplier: m.supplier ? { id: m.supplier.id, name: m.supplier.name } : null,
    })),
  )
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    reorderPoint: toOptionalNumber(body.reorderPoint) ?? 0,
    safetyStock: toOptionalNumber(body.safetyStock) ?? 0,
    leadTimeDays: toOptionalNumber(body.leadTimeDays) ?? 7,
    weightedAvgCost: toOptionalNumber(body.weightedAvgCost) ?? 0,
    supplierId: body.supplierId || null,
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

  const data = parsed.data

  let materialCode: string
  if (data.autoGenerateCode && data.boardType) {
    const base = generateMaterialCode(
      data.boardType,
      data.gsm ?? undefined,
      data.sheetLength ?? undefined,
      data.sheetWidth ?? undefined,
    )
    let code = base
    let suffix = 0
    while (await db.inventory.findUnique({ where: { materialCode: code } })) {
      suffix++
      code = `${base}-${suffix}`
    }
    materialCode = code
  } else {
    if (!data.materialCode?.trim()) {
      return NextResponse.json(
        { error: 'Validation failed', fields: { materialCode: 'Material code is required when auto-generate is off' } },
        { status: 400 },
      )
    }
    materialCode = data.materialCode.trim()
    const existing = await db.inventory.findUnique({ where: { materialCode } })
    if (existing) {
      return NextResponse.json(
        { error: 'Material code already exists', fields: { materialCode: 'Material code already exists' } },
        { status: 400 },
      )
    }
  }

  const material = await db.inventory.create({
    data: {
      materialCode,
      description: data.description?.trim() || materialCode,
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
