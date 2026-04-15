import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

function nextPlateSetCode(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PS-${year}-`
  return db.plateStore
    .findFirst({
      where: { plateSetCode: { startsWith: prefix } },
      orderBy: { plateSetCode: 'desc' },
      select: { plateSetCode: true },
    })
    .then((last) => {
      const lastSeq = last ? parseInt(last.plateSetCode.replace(prefix, ''), 10) || 0 : 0
      return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
    })
}

function nextPlateSerial(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PL-SN-${year}-`
  return db.plateStore
    .findFirst({
      where: { serialNumber: { startsWith: prefix } },
      orderBy: { serialNumber: 'desc' },
      select: { serialNumber: true },
    })
    .then((last) => {
      const lastSeq = last?.serialNumber
        ? parseInt(last.serialNumber.replace(prefix, ''), 10) || 0
        : 0
      return `${prefix}${String(lastSeq + 1).padStart(4, '0')}`
    })
}

const colourSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  status: z.enum(['new', 'old', 'issued', 'returned', 'destroyed']).default('new'),
  rackLocation: z.string().optional().nullable(),
  slotNumber: z.string().optional().nullable(),
  condition: z.string().optional().nullable(),
})

const createSchema = z
  .object({
    cartonName: z.string().min(1, 'Carton name is required'),
    artworkVersion: z.string().optional(),
    artworkCode: z.string().optional(),
    customerId: z.string().uuid().optional().nullable(),
    cartonId: z.string().uuid().optional().nullable(),
    artworkId: z.string().uuid().optional().nullable(),
    autoGenerateSerial: z.boolean().optional().default(false),
    serialNumber: z.string().optional().nullable(),
    outputNumber: z.string().optional().nullable(),
    rackNumber: z.string().optional().nullable(),
    ups: z.union([z.null(), z.number().int().min(1)]).optional(),
    numberOfColours: z.number().int().min(1).max(12),
    colours: z.array(colourSchema).min(1),
    rackLocation: z.string().optional().nullable(),
    slotNumber: z.string().optional().nullable(),
    ctpOperator: z.string().optional().nullable(),
    ctpDate: z.string().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (!data.autoGenerateSerial) {
      const s = String(data.serialNumber ?? '').trim()
      if (!s) {
        ctx.addIssue({
          code: 'custom',
          path: ['serialNumber'],
          message: 'Serial number is required when auto-generate is off',
        })
      }
    }
  })

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const customerId = searchParams.get('customerId')
  const status = searchParams.get('status')
  const q = searchParams.get('search')?.trim()
  const rackLocation = searchParams.get('rackLocation')?.trim()

  const where: {
    customerId?: string
    status?: string
    rackLocation?: { contains: string; mode: 'insensitive' }
    OR?: object[]
  } = {}
  if (customerId) where.customerId = customerId
  if (status) where.status = status
  if (rackLocation) where.rackLocation = { contains: rackLocation, mode: 'insensitive' }
  if (q && q.length >= 2) {
    where.OR = [
      { cartonName: { contains: q, mode: 'insensitive' as const } },
      { plateSetCode: { contains: q, mode: 'insensitive' as const } },
      { artworkCode: { contains: q, mode: 'insensitive' as const } },
    ]
  }

  const list = await db.plateStore.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { customer: { select: { id: true, name: true } } },
  })

  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    numberOfColours: body.numberOfColours != null ? Number(body.numberOfColours) : undefined,
    artworkVersion: body.artworkVersion ?? undefined,
    autoGenerateSerial: body.autoGenerateSerial === true,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path.join('.')
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const data = parsed.data
  const colours = data.colours
  const totalPlates = colours.length
  const newPlatesCount = colours.filter((v) => v.status === 'new').length
  const oldPlatesCount = colours.filter((v) => v.status === 'old' || v.status === 'returned').length
  // newPlatesCount / oldPlatesCount are local vars; Prisma fields are newPlates / oldPlates

  const plateSetCode = await nextPlateSetCode()
  const serialNumber = data.autoGenerateSerial
    ? await nextPlateSerial()
    : String(data.serialNumber ?? '').trim()

  const rackNum = String(data.rackNumber ?? '').trim() || null
  const rackLocation = data.rackLocation?.trim() || rackNum
  const outputTrim = data.outputNumber?.trim() || null
  const slotNum = data.slotNumber?.trim() || outputTrim || null

  let created
  try {
    created = await db.plateStore.create({
      data: {
        plateSetCode,
        serialNumber,
        outputNumber: outputTrim,
        rackNumber: rackNum,
        ups: data.ups ?? null,
        cartonName: data.cartonName.trim(),
        customerId: data.customerId ?? null,
        cartonId: data.cartonId ?? null,
        artworkId: data.artworkId ?? null,
        artworkCode: data.artworkCode ?? null,
        artworkVersion: data.artworkVersion ?? null,
        numberOfColours: data.numberOfColours,
        colours,
        totalPlates,
        newPlates: newPlatesCount,
        oldPlates: oldPlatesCount,
        rackLocation,
        slotNumber: slotNum,
        ctpOperator: data.ctpOperator ?? null,
        ctpDate: data.ctpDate ? new Date(data.ctpDate) : null,
        status: 'ready',
      },
    })
  } catch (e) {
    console.error('[plate-store POST]', e)
    const msg = e instanceof Error ? e.message : 'Database error'
    return NextResponse.json(
      { error: msg.includes('Unknown arg') || msg.includes('column') ? 'Database may need migration (plate fields).' : msg },
      { status: 500 },
    )
  }

  await db.plateAuditLog.create({
    data: {
      plateStoreId: created.id,
      plateSetCode: created.plateSetCode,
      action: 'created',
      performedBy: user!.id,
      details: {
        cartonName: created.cartonName,
        numberOfColours: created.numberOfColours,
        rackLocation: created.rackLocation,
      },
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'plate_store',
    recordId: created.id,
    newValue: { plateSetCode: created.plateSetCode, cartonName: created.cartonName },
  })

  return NextResponse.json(created)
}
