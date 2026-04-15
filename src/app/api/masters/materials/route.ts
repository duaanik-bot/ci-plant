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

  const list = await db.$queryRawUnsafe<Array<{
    id: string
    materialCode: string
    description: string
    unit: string
    qtyQuarantine: number
    qtyAvailable: number
    qtyReserved: number
    qtyFg: number
    weightedAvgCost: number
    reorderPoint: number
    safetyStock: number
    active: boolean
    boardType: string | null
    gsm: number | null
    sheetLength: number | null
    sheetWidth: number | null
    brightnessPct: number | null
    moisturePct: number | null
    supplierId: string | null
    supplierName: string | null
  }>>(`
    select
      i.id,
      i.material_code as "materialCode",
      i.description,
      i.unit,
      i.qty_quarantine::float8 as "qtyQuarantine",
      i.qty_available::float8 as "qtyAvailable",
      i.qty_reserved::float8 as "qtyReserved",
      i.qty_fg::float8 as "qtyFg",
      i.weighted_avg_cost::float8 as "weightedAvgCost",
      i.reorder_point::float8 as "reorderPoint",
      i.safety_stock::float8 as "safetyStock",
      i.active,
      i.board_type as "boardType",
      i.gsm,
      i.sheet_length::float8 as "sheetLength",
      i.sheet_width::float8 as "sheetWidth",
      i.brightness_pct::float8 as "brightnessPct",
      i.moisture_pct::float8 as "moisturePct",
      s.id as "supplierId",
      s.name as "supplierName"
    from inventory i
    left join suppliers s on s.id = i.supplier_id
    order by i.material_code asc
  `)
  return NextResponse.json(list.map((m) => ({
    id: m.id,
    materialCode: m.materialCode,
    description: m.description,
    unit: m.unit,
    qtyQuarantine: m.qtyQuarantine,
    qtyAvailable: m.qtyAvailable,
    qtyReserved: m.qtyReserved,
    qtyFg: m.qtyFg,
    weightedAvgCost: m.weightedAvgCost,
    reorderPoint: m.reorderPoint,
    safetyStock: m.safetyStock,
    active: m.active,
    boardType: m.boardType,
    gsm: m.gsm,
    sheetLength: m.sheetLength,
    sheetWidth: m.sheetWidth,
    brightnessPct: m.brightnessPct,
    moisturePct: m.moisturePct,
    supplier: m.supplierId ? { id: m.supplierId, name: m.supplierName ?? '' } : null,
  })))
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
      boardType: data.boardType || null,
      gsm: data.gsm ?? null,
      sheetLength: data.sheetLength ?? null,
      sheetWidth: data.sheetWidth ?? null,
      grainDirection: data.grainDirection || null,
      caliperMicrons: data.caliperMicrons ?? null,
      brightnessPct: data.brightnessPct ?? null,
      moisturePct: data.moisturePct ?? null,
      hsnCode: data.hsnCode?.trim() || null,
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
