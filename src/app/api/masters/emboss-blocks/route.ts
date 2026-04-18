// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  blockCode: z.string().min(1, 'Block code is required'),
  cartonId: z.string().uuid().optional().nullable(),
  cartonName: z.string().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  blockType: z.string().min(1, 'Block type is required'),
  blockMaterial: z.string().optional(),
  materialType: z.string().max(32).optional().nullable(),
  blockSize: z.string().optional().nullable(),
  embossDepth: z.number().optional().nullable(),
  reliefDepthMm: z.number().optional().nullable(),
  storageLocation: z.string().optional().nullable(),
  linkedDieId: z.string().uuid().optional().nullable(),
  artworkRefLink: z.string().max(600).optional().nullable(),
  maxImpressions: z.number().int().min(1).optional(),
  condition: z.string().optional(),
  manufactureDate: z.string().optional().nullable(),
  replacesBlockId: z.string().uuid().optional().nullable(),
})

export async function GET(req: NextRequest) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim()
  const activeOnly = searchParams.get('active') !== 'false'

  const where: { active?: boolean; OR?: object[] } = {}
  if (activeOnly) where.active = true
  if (q && q.length >= 1) {
    where.OR = [
      { blockCode: { contains: q, mode: 'insensitive' as const } },
      { cartonName: { contains: q, mode: 'insensitive' as const } },
    ]
  }

  const list = await db.embossBlock.findMany({
    where,
    orderBy: { blockCode: 'asc' },
    include: {
      _count: { select: { usageLogs: true } },
    },
  })

  const mapped = list.map((b) => ({
    ...b,
    totalTimesUsed: b._count.usageLogs,
    _count: undefined,
  }))

  return NextResponse.json(mapped)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    embossDepth: body.embossDepth != null ? Number(body.embossDepth) : undefined,
    maxImpressions: body.maxImpressions != null ? Number(body.maxImpressions) : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = (i.path[0] as string) ?? ''
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const exists = await db.embossBlock.findUnique({
    where: { blockCode: parsed.data.blockCode.trim() },
  })
  if (exists) {
    return NextResponse.json(
      { error: 'Block code already exists', fields: { blockCode: 'Block code already exists' } },
      { status: 400 },
    )
  }

  const data = parsed.data
  const relief = data.reliefDepthMm ?? data.embossDepth ?? null
  const block = await db.embossBlock.create({
    data: {
      blockCode: data.blockCode.trim(),
      cartonId: data.cartonId ?? null,
      cartonName: data.cartonName?.trim() ?? null,
      customerId: data.customerId ?? null,
      blockType: data.blockType.trim(),
      blockMaterial: (data.blockMaterial?.trim() || 'Magnesium') as string,
      materialType: data.materialType?.trim() || null,
      blockSize: data.blockSize?.trim() ?? null,
      embossDepth: relief,
      reliefDepthMm: relief,
      storageLocation: data.storageLocation?.trim() ?? null,
      linkedDieId: data.linkedDieId ?? null,
      artworkRefLink: data.artworkRefLink?.trim() ?? null,
      maxImpressions: data.maxImpressions ?? 100000,
      condition: (data.condition?.trim() || 'Good') as string,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'emboss_blocks',
    recordId: block.id,
    newValue: { blockCode: block.blockCode },
  })

  return NextResponse.json(block, { status: 201 })
}
