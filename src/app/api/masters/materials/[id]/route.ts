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
  packetWeight: z.number().positive().optional(),
  sheetsPerPacket: z.number().int().positive().optional(),
  active: z.boolean().optional(),
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
    packetWeight: Number(m.maxDailyUsage),
    sheetsPerPacket: m.maxStorageQty != null ? Number(m.maxStorageQty) : null,
    reorderPoint: Number(m.reorderPoint),
    safetyStock: Number(m.safetyStock),
    active: m.active,
    storageLocation: m.storageLocation,
    leadTimeDays: m.leadTimeDays,
    boardType: m.boardType,
    boardClassification: m.boardType,
    gsm: m.gsm,
    sheetLength: m.sheetLength != null ? Number(m.sheetLength) : null,
    sheetWidth: m.sheetWidth != null ? Number(m.sheetWidth) : null,
    attributes: m.attributes,
    physicalStockSheets: Number(m.physicalStockSheets),
    shortageSheets: Number(m.shortageSheets),
    totalWeightKg: Number(m.totalWeightKg),
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
    packetWeight: toOptionalNumber(body.packetWeight),
    sheetsPerPacket: toOptionalNumber(body.sheetsPerPacket),
    supplierId: body.supplierId === '' ? null : body.supplierId,
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

  const existing = await db.inventory.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const data = parsed.data
  const nextBoardType = data.boardType ?? existing.boardType
  const nextGsm = data.gsm ?? existing.gsm
  const nextSheetLength = data.sheetLength ?? (existing.sheetLength != null ? Number(existing.sheetLength) : null)
  const nextSheetWidth = data.sheetWidth ?? (existing.sheetWidth != null ? Number(existing.sheetWidth) : null)
  const nextSheetsPerPacket =
    data.sheetsPerPacket ??
    (existing.maxStorageQty != null ? Number(existing.maxStorageQty) : null) ??
    defaultSheetsPerPacket(nextBoardType)
  const existingPacketWeight = Number(existing.maxDailyUsage)
  const nextPacketWeight =
    data.packetWeight ??
    (existingPacketWeight > 0
      ? existingPacketWeight
      : computePacketWeight(nextSheetLength, nextSheetWidth, nextGsm, nextSheetsPerPacket))
  const fields: Record<string, string> = {}
  if (!nextBoardType?.trim()) fields.boardType = 'Board Type is required'
  if (!nextSheetLength || nextSheetLength <= 0) fields.sheetLength = 'Sheet length is required'
  if (!nextSheetWidth || nextSheetWidth <= 0) fields.sheetWidth = 'Sheet width is required'
  if (!nextGsm || nextGsm <= 0) fields.gsm = 'GSM is required'
  if (!nextPacketWeight || nextPacketWeight <= 0) fields.packetWeight = 'Packet weight is required'
  if (!nextSheetsPerPacket || nextSheetsPerPacket <= 0) fields.sheetsPerPacket = 'Sheets per packet is required'
  if (Object.keys(fields).length > 0) {
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }
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

  if (data.boardType && data.gsm && data.sheetLength && data.sheetWidth) {
    const duplicateSpec = await db.inventory.findFirst({
      where: {
        id: { not: id },
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

  const nextAttributes = data.attributes ?? existing.attributes
  const qtyAvailable = Number(existing.qtyAvailable)
  const totalWeightKg =
    nextSheetLength && nextSheetWidth && nextGsm
      ? Number(((qtyAvailable * (nextSheetLength * nextSheetWidth * nextGsm)) / 1_000_000).toFixed(6))
      : Number(existing.totalWeightKg)
  const computedDescription = [nextBoardType || '', nextGsm ? `${nextGsm} GSM` : '', (nextAttributes || '').trim()]
    .filter(Boolean)
    .join(' · ')

  const material = await db.inventory.update({
    where: { id },
    data: {
      ...(data.materialCode != null && { materialCode: data.materialCode.trim() }),
      description: computedDescription || data.description?.trim() || existing.description,
      ...(data.unit != null && { unit: data.unit }),
      ...(data.reorderPoint != null && { reorderPoint: data.reorderPoint }),
      ...(data.safetyStock != null && { safetyStock: data.safetyStock }),
      ...(data.storageLocation !== undefined && { storageLocation: data.storageLocation || null }),
      ...(data.leadTimeDays != null && { leadTimeDays: data.leadTimeDays }),
      ...(data.supplierId !== undefined && { supplierId: data.supplierId }),
      ...(data.weightedAvgCost != null && { weightedAvgCost: data.weightedAvgCost }),
      ...(data.packetWeight != null && { maxDailyUsage: data.packetWeight }),
      ...(data.sheetsPerPacket != null && { maxStorageQty: data.sheetsPerPacket }),
      ...(data.active !== undefined && { active: data.active }),
      ...(data.boardType !== undefined && { boardType: data.boardType || null }),
      ...(data.boardType !== undefined && { boardClassification: data.boardType || null }),
      ...(data.gsm !== undefined && { gsm: data.gsm ?? null }),
      ...(data.sheetLength !== undefined && { sheetLength: data.sheetLength ?? null }),
      ...(data.sheetWidth !== undefined && { sheetWidth: data.sheetWidth ?? null }),
      ...(data.attributes !== undefined && { attributes: data.attributes || null }),
      totalWeightKg,
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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const existing = await db.inventory.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Material not found' }, { status: 404 })

  const force = req.nextUrl.searchParams.get('force') === '1' || req.nextUrl.searchParams.get('force') === 'true'

  if (!force) {
    await db.inventory.delete({ where: { id } })
  } else {
    await db.$transaction(async (tx) => {
      await tx.grnShortageAllocation.deleteMany({ where: { materialId: id } })
      await tx.materialReservation.deleteMany({ where: { materialId: id } })
      await tx.materialShortage.deleteMany({ where: { materialId: id } })
      await tx.purchaseRequisition.deleteMany({ where: { materialId: id } })
      await tx.stockMovement.deleteMany({ where: { materialId: id } })
      await tx.sheetIssue.deleteMany({ where: { materialId: id } })
      await tx.wasteRecord.deleteMany({ where: { materialId: id } })
      await tx.bomLine.deleteMany({ where: { materialId: id } })
      await tx.inventory.delete({ where: { id } })
    })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'DELETE',
    tableName: 'inventory',
    recordId: id,
    oldValue: { materialCode: existing.materialCode, description: existing.description },
  })

  return NextResponse.json({ ok: true })
}
