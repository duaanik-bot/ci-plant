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

const createSchema = z.object({
  cartonName: z.string().min(1),
  customerId: z.string().uuid().optional().nullable(),
  cartonId: z.string().uuid().optional().nullable(),
  artworkId: z.string().uuid().optional().nullable(),
  artworkVersion: z.string().optional().nullable(),
  numberOfColours: z.number().int().min(1).max(6),
  colours: z.record(z.string(), z.enum(['new', 'old', 'destroyed'])),
  storageLocation: z.string().optional().nullable(),
  storageNotes: z.string().optional().nullable(),
  ctpOperator: z.string().optional().nullable(),
  ctpDate: z.string().optional().nullable(),
  jobCardId: z.string().uuid().optional().nullable(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const customerId = searchParams.get('customerId')
  const status = searchParams.get('status')
  const q = searchParams.get('q')?.trim()

  const where: { customerId?: string; status?: string; OR?: object[] } = {}
  if (customerId) where.customerId = customerId
  if (status) where.status = status
  if (q && q.length >= 2) {
    where.OR = [
      { cartonName: { contains: q, mode: 'insensitive' as const } },
      { plateSetCode: { contains: q, mode: 'insensitive' as const } },
      { artworkVersion: { contains: q, mode: 'insensitive' as const } },
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
  const colours = data.colours as Record<string, string>
  const totalPlates = Object.keys(colours).length
  const newPlates = Object.values(colours).filter((v) => v === 'new').length
  const oldPlates = Object.values(colours).filter((v) => v === 'old').length

  const plateSetCode = await nextPlateSetCode()

  const created = await db.plateStore.create({
    data: {
      plateSetCode,
      cartonName: data.cartonName.trim(),
      customerId: data.customerId ?? null,
      cartonId: data.cartonId ?? null,
      artworkId: data.artworkId ?? null,
      artworkVersion: data.artworkVersion ?? null,
      jobCardId: data.jobCardId ?? null,
      numberOfColours: data.numberOfColours,
      colours: colours as object,
      totalPlates,
      newPlates,
      oldPlates,
      storageLocation: data.storageLocation ?? null,
      ctpOperator: data.ctpOperator ?? null,
      ctpDate: data.ctpDate ? new Date(data.ctpDate) : null,
      storageNotes: data.storageNotes ?? null,
      status: 'in_use',
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
