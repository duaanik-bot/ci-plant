import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  dyeType: z.string().optional(),
  ups: z.number().int().min(1).optional(),
  sheetSize: z.string().optional(),
  cartonSize: z.string().optional(),
  location: z.string().optional(),
  maxImpressions: z.number().int().min(1).optional(),
  conditionRating: z.string().optional().nullable(),
  condition: z.string().optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const dye = await db.dye.findUnique({
    where: { id },
    include: {
      usageLogs: { orderBy: { usedOn: 'desc' }, take: 50 },
      maintenanceLogs: { orderBy: { performedAt: 'desc' }, take: 50 },
    },
  })
  if (!dye) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(dye)
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
    ups: body.ups != null ? Number(body.ups) : undefined,
    maxImpressions: body.maxImpressions != null ? Number(body.maxImpressions) : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.dye.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data = parsed.data
  const updatePayload: Record<string, unknown> = {
    ...(data.dyeType !== undefined ? { dyeType: data.dyeType } : {}),
    ...(data.ups !== undefined ? { ups: data.ups } : {}),
    ...(data.sheetSize !== undefined ? { sheetSize: data.sheetSize } : {}),
    ...(data.cartonSize !== undefined ? { cartonSize: data.cartonSize } : {}),
    ...(data.location !== undefined ? { location: data.location || null } : {}),
    ...(data.maxImpressions !== undefined ? { maxImpressions: data.maxImpressions } : {}),
    ...(data.conditionRating !== undefined ? { conditionRating: data.conditionRating } : {}),
    ...(data.condition !== undefined ? { condition: data.condition } : {}),
  }
  const updated = await db.dye.update({
    where: { id },
    data: updatePayload,
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'dyes',
    recordId: id,
    newValue: parsed.data,
  })

  return NextResponse.json(updated)
}

