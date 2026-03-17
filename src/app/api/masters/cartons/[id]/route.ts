import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  cartonName: z.string().min(1).optional(),
  productType: z.string().optional(),
  category: z.string().optional(),
  rate: z.number().min(0).optional(),
  gstPct: z.number().int().min(0).max(28).optional(),
  active: z.boolean().optional(),
  boardGrade: z.string().optional(),
  gsm: z.number().int().optional(),
  caliperMicrons: z.number().int().optional(),
  paperType: z.string().optional(),
  plyCount: z.number().int().min(1).max(3).optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await context.params
  const carton = await db.carton.findUnique({
    where: { id },
    include: { customer: { select: { id: true, name: true } } },
  })
  if (!carton) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    ...carton,
    rate: carton.rate != null ? Number(carton.rate) : null,
  })
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
    rate: body.rate != null ? Number(body.rate) : undefined,
    gstPct: body.gstPct != null ? Number(body.gstPct) : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = i.path[0] as string
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const existing = await db.carton.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data = parsed.data
  const updated = await db.carton.update({
    where: { id },
    data: {
      ...(data.cartonName !== undefined ? { cartonName: data.cartonName } : {}),
      ...(data.productType !== undefined ? { productType: data.productType || null } : {}),
      ...(data.category !== undefined ? { category: data.category || null } : {}),
      ...(data.rate !== undefined ? { rate: data.rate } : {}),
      ...(data.gstPct !== undefined ? { gstPct: data.gstPct } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.boardGrade !== undefined ? { boardGrade: data.boardGrade || null } : {}),
      ...(data.gsm !== undefined ? { gsm: data.gsm } : {}),
      ...(data.caliperMicrons !== undefined ? { caliperMicrons: data.caliperMicrons } : {}),
      ...(data.paperType !== undefined ? { paperType: data.paperType || null } : {}),
      ...(data.plyCount !== undefined ? { plyCount: data.plyCount } : {}),
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'cartons',
    recordId: id,
    newValue: parsed.data,
  })

  return NextResponse.json(updated)
}

