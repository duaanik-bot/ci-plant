import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  dyeNumber: z.number().int().min(1, 'Dye number is required'),
  dyeType: z.string().min(1, 'Dye type is required'),
  ups: z.number().int().min(1),
  sheetSize: z.string().min(1, 'Sheet size is required'),
  cartonSize: z.string().min(1, 'Carton size is required'),
  location: z.string().optional(),
  maxImpressions: z.number().int().min(1).optional(),
  conditionRating: z.string().optional(),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const list = await db.dye.findMany({
    orderBy: { dyeNumber: 'asc' },
  })
  return NextResponse.json(list)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse({
    ...body,
    dyeNumber: Number(body.dyeNumber),
    ups: Number(body.ups),
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

  const exists = await db.dye.findUnique({ where: { dyeNumber: parsed.data.dyeNumber } })
  if (exists) {
    return NextResponse.json(
      { error: 'Dye number already exists', fields: { dyeNumber: 'Dye number already exists' } },
      { status: 400 }
    )
  }

  const data = parsed.data

  const dye = await db.dye.create({
    data: {
      dyeNumber: data.dyeNumber,
      dyeType: data.dyeType,
      ups: data.ups,
      sheetSize: data.sheetSize,
      cartonSize: data.cartonSize,
      location: data.location || null,
      maxImpressions: data.maxImpressions ?? 500000,
      conditionRating: data.conditionRating || 'Good',
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'dyes',
    recordId: dye.id,
    newValue: { dyeNumber: dye.dyeNumber },
  })

  return NextResponse.json(dye, { status: 201 })
}

