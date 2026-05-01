import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  value: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
})

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireRole('operations_head', 'md')
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

  const updated = await db.effectValue.update({
    where: { id },
    data: {
      ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description || null } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    },
  })

  return NextResponse.json(updated)
}
