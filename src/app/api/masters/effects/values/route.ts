import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'
import { normalizeBoardTypeForStorage } from '@/lib/board-vocabulary'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  categoryId: z.string().uuid('Category is required'),
  code: z
    .string()
    .trim()
    .min(1, 'Code is required')
    .max(48)
    .regex(/^[A-Z0-9_]+$/, 'Uppercase letters, digits, underscore only'),
  value: z.string().trim().min(1, 'Value is required').max(120, 'Max 120 characters'),
  abbreviation: z.string().trim().max(24, 'Max 24 characters').optional().nullable(),
  impactOn: z.string().trim().max(80, 'Max 80 characters').optional().nullable(),
  description: z.string().trim().max(1000, 'Max 1000 characters').optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(100),
  active: z.boolean().default(true),
})

export async function GET(req: NextRequest) {
  try {
    const { error } = await requireRole('admin', 'plant_head')
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
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to load values'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { error } = await requireRole('admin', 'plant_head')
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

    const isBoardCategory = category.code === 'BOARD_TYPE' || category.code === 'BOARD_COLOUR' || category.name.trim().toLowerCase() === 'board type'
    const normalizedValue = isBoardCategory
      ? normalizeBoardTypeForStorage(parsed.data.value) ?? parsed.data.value
      : parsed.data.value

    const duplicate = await db.effectValue.findFirst({
      where: {
        categoryId: parsed.data.categoryId,
        value: { equals: normalizedValue, mode: 'insensitive' },
      },
      select: { id: true },
    })
    if (duplicate) {
      return NextResponse.json(
        { error: 'Value already exists in this category', fields: { value: 'Value already exists' } },
        { status: 400 },
      )
    }

    const dupCode = await db.effectValue.findFirst({
      where: { categoryId: parsed.data.categoryId, code: parsed.data.code },
      select: { id: true },
    })
    if (dupCode) {
      return NextResponse.json(
        { error: 'Code already exists in this category', fields: { code: 'Code already exists' } },
        { status: 400 },
      )
    }

    const created = await db.effectValue.create({
      data: {
        categoryId: parsed.data.categoryId,
        code: parsed.data.code,
        value: normalizedValue,
        abbreviation: parsed.data.abbreviation || null,
        impactOn: parsed.data.impactOn || null,
        description: parsed.data.description || null,
        sortOrder: parsed.data.sortOrder,
        active: parsed.data.active,
      },
    })

    return NextResponse.json(created, { status: 201 })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to create value'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
