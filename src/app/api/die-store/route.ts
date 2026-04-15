// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  dyeId: z.string().optional().nullable(),
  dieNumber: z.number().int().optional().nullable(),
  dieType: z.string().min(1),
  ups: z.number().int().min(1).default(1),
  sheetSize: z.string().optional().nullable(),
  cartonSize: z.string().optional().nullable(),
  cartonId: z.string().optional().nullable(),
  cartonName: z.string().optional().nullable(),
  customerId: z.string().optional().nullable(),
  condition: z.string().optional(),
  storageLocation: z.string().optional().nullable(),
  compartment: z.string().optional().nullable(),
  maxImpressions: z.number().int().min(1).optional(),
  createdBy: z.string().optional().nullable(),
})

async function nextDieCode(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `DI-${year}-`
  const last = await db.dieStore.findFirst({
    where: { dieCode: { startsWith: prefix } },
    orderBy: { dieCode: 'desc' },
    select: { dieCode: true },
  })
  const seq = last ? Number(last.dieCode.replace(prefix, '')) || 0 : 0
  return `${prefix}${String(seq + 1).padStart(4, '0')}`
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const sp = req.nextUrl.searchParams
  const status = sp.get('status') ?? undefined
  const condition = sp.get('condition') ?? undefined
  const search = sp.get('search')?.trim() ?? ''
  const location = sp.get('location')?.trim() ?? ''

  const rows = await db.dieStore.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(condition ? { condition } : {}),
      ...(location ? { storageLocation: { contains: location, mode: 'insensitive' } } : {}),
      ...(search
        ? {
            OR: [
              { dieCode: { contains: search, mode: 'insensitive' } },
              { cartonName: { contains: search, mode: 'insensitive' } },
              { dieNumber: Number.isFinite(Number(search)) ? Number(search) : undefined },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error
  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    dieNumber: body.dieNumber != null ? Number(body.dieNumber) : undefined,
    ups: body.ups != null ? Number(body.ups) : 1,
    maxImpressions: body.maxImpressions != null ? Number(body.maxImpressions) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const dieCode = await nextDieCode()
  const created = await db.dieStore.create({
    data: {
      dieCode,
      dieNumber: parsed.data.dieNumber ?? null,
      dieType: parsed.data.dieType,
      ups: parsed.data.ups,
      sheetSize: parsed.data.sheetSize ?? null,
      cartonSize: parsed.data.cartonSize ?? null,
      cartonId: parsed.data.cartonId ?? null,
      cartonName: parsed.data.cartonName ?? null,
      customerId: parsed.data.customerId ?? null,
      condition: parsed.data.condition ?? 'New',
      storageLocation: parsed.data.storageLocation ?? null,
      compartment: parsed.data.compartment ?? null,
      maxImpressions: parsed.data.maxImpressions ?? 500000,
      ...(parsed.data.dyeId ? { dye: { connect: { id: parsed.data.dyeId } } } : {}),
      createdBy: parsed.data.createdBy ?? user?.id ?? null,
    },
  })
  await db.dieAuditLog.create({
    data: {
      dieStoreId: created.id,
      dieCode: created.dieCode,
      action: 'created',
      performedBy: user?.id ?? 'system',
      details: created,
    },
  })
  return NextResponse.json(created, { status: 201 })
}
