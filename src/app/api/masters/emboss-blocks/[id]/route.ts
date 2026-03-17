import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  cartonId: z.string().uuid().optional().nullable(),
  cartonName: z.string().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  blockType: z.string().optional(),
  blockMaterial: z.string().optional(),
  blockSize: z.string().optional().nullable(),
  embossDepth: z.number().optional().nullable(),
  storageLocation: z.string().optional().nullable(),
  maxImpressions: z.number().int().min(1).optional(),
  condition: z.string().optional(),
  active: z.boolean().optional(),
})

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const block = await db.embossBlock.findUnique({
    where: { id },
    include: {
      usageLogs: { orderBy: { usedOn: 'desc' }, take: 50 },
      maintenanceLogs: { orderBy: { performedAt: 'desc' }, take: 50 },
    },
  })
  if (!block) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(block)
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
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

  const existing = await db.embossBlock.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data = parsed.data
  const updated = await db.embossBlock.update({
    where: { id },
    data: {
      ...(data.cartonId !== undefined ? { cartonId: data.cartonId } : {}),
      ...(data.cartonName !== undefined ? { cartonName: data.cartonName?.trim() ?? null } : {}),
      ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
      ...(data.blockType !== undefined ? { blockType: data.blockType } : {}),
      ...(data.blockMaterial !== undefined ? { blockMaterial: data.blockMaterial } : {}),
      ...(data.blockSize !== undefined ? { blockSize: data.blockSize?.trim() ?? null } : {}),
      ...(data.embossDepth !== undefined ? { embossDepth: data.embossDepth } : {}),
      ...(data.storageLocation !== undefined ? { storageLocation: data.storageLocation?.trim() ?? null } : {}),
      ...(data.maxImpressions !== undefined ? { maxImpressions: data.maxImpressions } : {}),
      ...(data.condition !== undefined ? { condition: data.condition } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'emboss_blocks',
    recordId: id,
    newValue: parsed.data,
  })

  return NextResponse.json(updated)
}
