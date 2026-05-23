import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  code: z.string().trim().min(1).max(48).regex(/^[A-Z0-9_]+$/).optional(),
  value: z.string().trim().min(1).max(120).optional(),
  abbreviation: z.string().trim().max(24).nullable().optional(),
  impactOn: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
})

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireRole('admin', 'plant_head')
  if (error) return error

  const { id } = await params
  const existing = await db.effectValue.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Value not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((issue) => {
      const key = String(issue.path[0] || 'value')
      fields[key] = issue.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  if (parsed.data.value && parsed.data.value.toLowerCase() !== existing.value.toLowerCase()) {
    const duplicate = await db.effectValue.findFirst({
      where: {
        id: { not: id },
        categoryId: existing.categoryId,
        value: { equals: parsed.data.value, mode: 'insensitive' },
      },
      select: { id: true },
    })
    if (duplicate) {
      return NextResponse.json(
        { error: 'Value already exists in this category', fields: { value: 'Value already exists' } },
        { status: 400 },
      )
    }
  }

  if (parsed.data.code && parsed.data.code !== existing.code) {
    const refCount = await db.$queryRaw<{ c: number }[]>`
      SELECT (
        (SELECT count(*) FROM inventory     WHERE lower(coalesce(board_type,'')) = lower(${existing.value})) +
        (SELECT count(*) FROM po_line_items WHERE lower(coalesce(paper_type,''))  = lower(${existing.value}))
      )::int AS c`
    if (Number(refCount[0]?.c || 0) > 0) {
      return NextResponse.json(
        { error: 'Code is locked: this value is already referenced by records.', fields: { code: 'Locked (referenced)' } },
        { status: 409 },
      )
    }
    const dupCode = await db.effectValue.findFirst({
      where: { id: { not: id }, categoryId: existing.categoryId, code: parsed.data.code },
      select: { id: true },
    })
    if (dupCode) {
      return NextResponse.json(
        { error: 'Code already exists in this category', fields: { code: 'Code already exists' } },
        { status: 400 },
      )
    }
  }

  const updated = await db.effectValue.update({
    where: { id },
    data: {
      ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
      ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
      ...(parsed.data.abbreviation !== undefined ? { abbreviation: parsed.data.abbreviation || null } : {}),
      ...(parsed.data.impactOn !== undefined ? { impactOn: parsed.data.impactOn || null } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description || null } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireRole('admin', 'plant_head')
  if (error) return error

  const { id } = await params
  const existing = await db.effectValue.findUnique({
    where: { id },
    include: { category: { select: { name: true } } },
  })
  if (!existing) return NextResponse.json({ error: 'Value not found' }, { status: 404 })

  const value = existing.value.trim()
  const category = existing.category.name.trim().toLowerCase()
  const linkedQueries: Promise<unknown>[] = []

  if (category === 'board type') {
    linkedQueries.push(
      db.$queryRaw`SELECT count(*)::int AS c FROM inventory WHERE lower(coalesce(board_type,'')) = lower(${value})`,
      db.$queryRaw`SELECT count(*)::int AS c FROM material_queue WHERE lower(coalesce(board_type,'')) = lower(${value})`,
      db.$queryRaw`SELECT count(*)::int AS c FROM cartons WHERE lower(coalesce(paper_type,'')) = lower(${value})`,
      db.$queryRaw`SELECT count(*)::int AS c FROM po_line_items WHERE lower(coalesce(paper_type,'')) = lower(${value})`,
    )
  } else if (category === 'coating') {
    linkedQueries.push(
      db.$queryRaw`SELECT count(*)::int AS c FROM cartons WHERE lower(coalesce(coating_type,'')) = lower(${value})`,
      db.$queryRaw`SELECT count(*)::int AS c FROM po_line_items WHERE lower(coalesce(coating_type,'')) = lower(${value})`,
    )
  } else if (category === 'foil') {
    linkedQueries.push(
      db.$queryRaw`SELECT count(*)::int AS c FROM cartons WHERE lower(coalesce(foil_type,'')) = lower(${value})`,
      db.$queryRaw`SELECT count(*)::int AS c FROM po_line_items WHERE lower(coalesce(foil_type,'')) = lower(${value})`,
    )
  } else if (category === 'embossing') {
    linkedQueries.push(
      db.$queryRaw`SELECT count(*)::int AS c FROM cartons WHERE lower(coalesce(embossing_leafing,'')) = lower(${value})`,
      db.$queryRaw`SELECT count(*)::int AS c FROM po_line_items WHERE lower(coalesce(embossing_leafing,'')) = lower(${value})`,
    )
  }

  const linkedCounts = await Promise.all(linkedQueries)
  const hasLinks = linkedCounts.some((rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return false
    const first = rows[0] as { c?: number | null }
    return Number(first.c || 0) > 0
  })

  if (hasLinks) {
    return NextResponse.json(
      { error: 'This value is used in active records. Please inactivate instead.' },
      { status: 409 },
    )
  }

  await db.effectValue.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
