import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
})

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const existing = await db.effectCategory.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Category not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((issue) => {
      const key = String(issue.path[0] || 'name')
      fields[key] = issue.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const nextName = parsed.data.name?.trim()
  if (nextName && nextName.toLowerCase() !== existing.name.toLowerCase()) {
    const duplicate = await db.effectCategory.findFirst({
      where: {
        id: { not: id },
        name: { equals: nextName, mode: 'insensitive' },
      },
      select: { id: true },
    })
    if (duplicate) {
      return NextResponse.json(
        { error: 'Category already exists', fields: { name: 'Category already exists' } },
        { status: 400 },
      )
    }
  }

  const updated = await db.effectCategory.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id } = await params
  const existing = await db.effectCategory.findUnique({
    where: { id },
    include: { values: { select: { id: true } } },
  })
  if (!existing) return NextResponse.json({ error: 'Category not found' }, { status: 404 })

  const linkedValues = await db.effectValue.findMany({
    where: { categoryId: id },
    select: { id: true, value: true, category: { select: { name: true } } },
  })

  for (const v of linkedValues) {
    const value = v.value.trim()
    const category = v.category.name.trim().toLowerCase()
    const linkedQueries: Promise<unknown>[] = []
    if (category === 'board type') {
      linkedQueries.push(
        db.$queryRaw`SELECT count(*)::int AS c FROM inventory WHERE lower(coalesce(board_type,'')) = lower(${value})`,
        db.$queryRaw`SELECT count(*)::int AS c FROM material_queue WHERE lower(coalesce(board_type,'')) = lower(${value})`,
      )
    } else if (category === 'coating') {
      linkedQueries.push(
        db.$queryRaw`SELECT count(*)::int AS c FROM cartons WHERE lower(coalesce(coating_type,'')) = lower(${value})`,
      )
    }
    const linkedCounts = await Promise.all(linkedQueries)
    const inUse = linkedCounts.some((rows) => {
      if (!Array.isArray(rows) || rows.length === 0) return false
      const first = rows[0] as { c?: number | null }
      return Number(first.c || 0) > 0
    })
    if (inUse) {
      return NextResponse.json(
        { error: 'This value is used in active records. Please inactivate instead.' },
        { status: 400 },
      )
    }
  }

  await db.effectValue.deleteMany({ where: { categoryId: id } })
  await db.effectCategory.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
