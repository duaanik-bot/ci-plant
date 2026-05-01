import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  categoryId: z.string().uuid('Category is required'),
  value: z.string().trim().min(1, 'Value is required').max(120, 'Max 120 characters'),
  description: z.string().trim().max(1000, 'Max 1000 characters').optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(100),
  active: z.boolean().default(true),
})

export async function GET(req: NextRequest) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const categoryId = req.nextUrl.searchParams.get('categoryId')?.trim()
  if (!categoryId) {
    return NextResponse.json({ error: 'categoryId is required' }, { status: 400 })
  }

  const rows = await db.effectValue.findMany({
    where: { categoryId },
    orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }],
  })

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((issue) => {
      const key = String(issue.path[0] || 'value')
      fields[key] = issue.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const category = await db.effectCategory.findUnique({ where: { id: parsed.data.categoryId } })
  if (!category) {
    return NextResponse.json({ error: 'Category not found' }, { status: 404 })
  }

  const duplicate = await db.effectValue.findFirst({
    where: {
      categoryId: parsed.data.categoryId,
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

  const created = await db.effectValue.create({
    data: {
      categoryId: parsed.data.categoryId,
      value: parsed.data.value,
      description: parsed.data.description || null,
      sortOrder: parsed.data.sortOrder,
      active: parsed.data.active,
    },
  })

  return NextResponse.json(created, { status: 201 })
}
