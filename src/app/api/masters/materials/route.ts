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

function makeShortAbbr(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return cleaned.slice(0, 4) || 'BRD'
}

async function boardTypeAbbreviation(boardType: string): Promise<string> {
  const row = await db.effectValue.findFirst({
    where: {
      active: true,
      value: { equals: boardType, mode: 'insensitive' },
      category: { name: { equals: 'Board Type', mode: 'insensitive' } },
    },
    select: { abbreviation: true },
  })
  return makeShortAbbr(row?.abbreviation?.trim() || boardType)
}

async function generateMaterialCode(boardType: string, gsm?: number, sheetLength?: number, sheetWidth?: number): Promise<string> {
  const abbr = await boardTypeAbbreviation(boardType)
  const len = sheetLength ? Math.round(sheetLength) : 0
  const wid = sheetWidth ? Math.round(sheetWidth) : 0
  const gsmPart = gsm ? String(Math.round(gsm)) : ''
  return `${len}${wid}${abbr}${gsmPart}`
}

function computeWeightKg(availableSheets: number, length: number, width: number, gsm: number): number {
  if (!Number.isFinite(availableSheets) || !Number.isFinite(length) || !Number.isFinite(width) || !Number.isFinite(gsm)) return 0
  if (availableSheets <= 0 || length <= 0 || width <= 0 || gsm <= 0) return 0
  return Number(((availableSheets * (length * width * gsm)) / 1_000_000).toFixed(6))
}

function computeDescription(boardType: string | null | undefined, gsm: number | null | undefined, attributes: string | null | undefined): string {
  const board = (boardType || '').trim()
  const gsmPart = gsm && gsm > 0 ? `${gsm} GSM` : ''
  const attrs = (attributes || '').trim()
  return [board, gsmPart, attrs].filter(Boolean).join(' · ')
}

function defaultSheetsPerPacket(boardType: string | null | undefined): number | null {
  const key = (boardType || '').trim().toLowerCase()
  if (!key) return null
  if (key.includes('fbb')) return 100
  if (key.includes('saff')) return 144
  // Legacy fallback
  if (key.includes('sbs')) return 100
  if (key.includes('dup') || key.includes('duplex')) return 144
  return null
}

function computePacketWeight(lengthIn: number | null | undefined, widthIn: number | null | undefined, gsm: number | null | undefined, sheetsPerPacket: number | null | undefined): number | null {
  const l = Number(lengthIn)
  const w = Number(widthIn)
  const g = Number(gsm)
  const s = Number(sheetsPerPacket)
  if (!Number.isFinite(l) || !Number.isFinite(w) || !Number.isFinite(g) || !Number.isFinite(s) || l <= 0 || w <= 0 || g <= 0 || s <= 0) return null
  const sheetWeight = (l * w * g) / 3100 / 5 / s
  return Number((sheetWeight * s).toFixed(3))
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
  packetWeight: z.number().positive().optional().nullable(),
  sheetsPerPacket: z.number().int().positive().optional().nullable(),
  active: z.boolean().default(true),
  boardType: z.string().optional().nullable(),
  attributes: z.string().optional().nullable(),
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
      packetWeight: Number(m.maxDailyUsage),
      sheetsPerPacket: m.maxStorageQty != null ? Number(m.maxStorageQty) : null,
      reorderPoint: Number(m.reorderPoint),
      safetyStock: Number(m.safetyStock),
      active: m.active,
      boardType: m.boardType,
      boardClassification: m.boardType,
      gsm: m.gsm,
      sheetLength: m.sheetLength != null ? Number(m.sheetLength) : null,
      sheetWidth: m.sheetWidth != null ? Number(m.sheetWidth) : null,
      attributes: m.attributes,
      physicalStockSheets: Number(m.physicalStockSheets),
      shortageSheets: Number(m.shortageSheets),
      totalWeightKg: Number(m.totalWeightKg),
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
    packetWeight: toOptionalNumber(body.packetWeight),
    sheetsPerPacket: toOptionalNumber(body.sheetsPerPacket),
    supplierId: body.supplierId || null,
    gsm: toOptionalNumber(body.gsm),
    attributes: typeof body.attributes === 'string' ? body.attributes : null,
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
  const fields: Record<string, string> = {}
  if (!data.boardType?.trim()) fields.boardType = 'Board Type is required'
  if (!data.sheetLength || data.sheetLength <= 0) fields.sheetLength = 'Sheet length is required'
  if (!data.sheetWidth || data.sheetWidth <= 0) fields.sheetWidth = 'Sheet width is required'
  if (!data.gsm || data.gsm <= 0) fields.gsm = 'GSM is required'
  const resolvedSheetsPerPacket = data.sheetsPerPacket ?? defaultSheetsPerPacket(data.boardType)
  const resolvedPacketWeight =
    data.packetWeight ??
    computePacketWeight(data.sheetLength, data.sheetWidth, data.gsm, resolvedSheetsPerPacket)
  if (!resolvedSheetsPerPacket || resolvedSheetsPerPacket <= 0) fields.sheetsPerPacket = 'Sheets per packet is required'
  if (!resolvedPacketWeight || resolvedPacketWeight <= 0) fields.packetWeight = 'Packet weight is required'
  if (Object.keys(fields).length > 0) {
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  let materialCode: string
  if (data.autoGenerateCode && data.boardType) {
    const base = await generateMaterialCode(
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

  if (data.boardType && data.gsm && data.sheetLength && data.sheetWidth) {
    const duplicateSpec = await db.inventory.findFirst({
      where: {
        boardType: data.boardType,
        gsm: data.gsm,
        sheetLength: data.sheetLength,
        sheetWidth: data.sheetWidth,
      },
      select: { id: true },
    })
    if (duplicateSpec) {
      return NextResponse.json(
        { error: 'Duplicate material spec already exists', fields: { boardType: 'Same board + size + gsm already exists' } },
        { status: 400 },
      )
    }
  }

  const qtyAvailable = 0
  const physicalStockSheets = 0
  const shortageSheets = 0
  const totalWeightKg = computeWeightKg(qtyAvailable, data.sheetLength ?? 0, data.sheetWidth ?? 0, data.gsm ?? 0)
  const finalDescription = computeDescription(data.boardType, data.gsm, data.attributes) || data.description?.trim() || materialCode

  const material = await db.inventory.create({
    data: {
      materialCode,
      description: finalDescription,
      boardType: data.boardType || null,
      boardClassification: data.boardType || null,
      sheetLength: data.sheetLength ?? null,
      sheetWidth: data.sheetWidth ?? null,
      gsm: data.gsm ?? null,
      attributes: data.attributes || null,
      unit: data.unit,
      reorderPoint: data.reorderPoint,
      safetyStock: data.safetyStock,
      storageLocation: data.storageLocation || null,
      leadTimeDays: data.leadTimeDays,
      supplierId: data.supplierId || null,
      weightedAvgCost: data.weightedAvgCost,
      maxDailyUsage: resolvedPacketWeight,
      maxStorageQty: resolvedSheetsPerPacket,
      physicalStockSheets,
      shortageSheets,
      totalWeightKg,
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
