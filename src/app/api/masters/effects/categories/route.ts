import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').max(80, 'Max 80 characters'),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(100),
  active: z.boolean().default(true),
})

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const categories = await db.effectCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      _count: {
        select: {
          values: true,
        },
      },
    },
  })

  return NextResponse.json(
    categories.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      active: c.active,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      valueCount: c._count.values,
    })),
  )
}

export async function POST(req: NextRequest) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((issue) => {
      const key = String(issue.path[0] || 'name')
      fields[key] = issue.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const duplicate = await db.effectCategory.findFirst({
    where: { name: { equals: parsed.data.name, mode: 'insensitive' } },
    select: { id: true },
  })
  if (duplicate) {
    return NextResponse.json(
      { error: 'Category already exists', fields: { name: 'Category already exists' } },
      { status: 400 },
    )
  }

  const created = await db.effectCategory.create({
    data: {
      name: parsed.data.name,
      sortOrder: parsed.data.sortOrder,
      active: parsed.data.active,
    },
  })

  return NextResponse.json(created, { status: 201 })
}
