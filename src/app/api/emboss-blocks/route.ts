import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  blockNumber: z.number().int().optional().nullable(),
  blockType: z.string().min(1),
  blockMaterial: z.string().optional(),
  cartonId: z.string().optional().nullable(),
  cartonName: z.string().optional().nullable(),
  customerId: z.string().optional().nullable(),
  artworkCode: z.string().optional().nullable(),
  embossArea: z.string().optional().nullable(),
  storageLocation: z.string().optional().nullable(),
  compartment: z.string().optional().nullable(),
  maxImpressions: z.number().int().min(1).optional(),
  condition: z.string().optional(),
  createdBy: z.string().optional().nullable(),
})

async function nextBlockCode(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `EB-${year}-`
  const last = await db.embossBlock.findFirst({
    where: { blockCode: { startsWith: prefix } },
    orderBy: { blockCode: 'desc' },
    select: { blockCode: true },
  })
  const seq = last ? Number(last.blockCode.replace(prefix, '')) || 0 : 0
  return `${prefix}${String(seq + 1).padStart(4, '0')}`
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const sp = req.nextUrl.searchParams
  const status = sp.get('status') ?? undefined
  const condition = sp.get('condition') ?? undefined
  const search = sp.get('search')?.trim() ?? ''
  const rows = await db.embossBlock.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(condition ? { condition } : {}),
      ...(search
        ? {
            OR: [
              { blockCode: { contains: search, mode: 'insensitive' } },
              { cartonName: { contains: search, mode: 'insensitive' } },
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
    blockNumber: body.blockNumber != null ? Number(body.blockNumber) : undefined,
    maxImpressions: body.maxImpressions != null ? Number(body.maxImpressions) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const blockCode = await nextBlockCode()
  const created = await db.embossBlock.create({
    data: {
      blockCode,
      blockNumber: parsed.data.blockNumber ?? null,
      blockType: parsed.data.blockType,
      blockMaterial: parsed.data.blockMaterial ?? 'Magnesium',
      cartonId: parsed.data.cartonId ?? null,
      cartonName: parsed.data.cartonName ?? null,
      customerId: parsed.data.customerId ?? null,
      artworkCode: parsed.data.artworkCode ?? null,
      embossArea: parsed.data.embossArea ?? null,
      storageLocation: parsed.data.storageLocation ?? null,
      compartment: parsed.data.compartment ?? null,
      maxImpressions: parsed.data.maxImpressions ?? 100000,
      condition: parsed.data.condition ?? 'New',
      status: 'in_stock',
      createdBy: parsed.data.createdBy ?? user?.id ?? null,
    },
  })
  await db.embossAuditLog.create({
    data: {
      embossBlockId: created.id,
      blockCode: created.blockCode,
      action: 'created',
      performedBy: user?.id ?? 'system',
      details: created,
    },
  })
  return NextResponse.json(created, { status: 201 })
}

