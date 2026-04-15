// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  vendorName: z.string().optional(),
  vendorContact: z.string().optional().nullable(),
  quotedCost: z.number().optional().nullable(),
  finalCost: z.number().optional().nullable(),
  advancePaid: z.number().optional().nullable(),
  expectedBy: z.string().optional().nullable(),
  status: z.string().optional(),
  priority: z.string().optional(),
})

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const row = await db.dieVendorOrder.findUnique({ where: { id } })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(row)
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse({
    ...body,
    quotedCost: body.quotedCost != null ? Number(body.quotedCost) : undefined,
    finalCost: body.finalCost != null ? Number(body.finalCost) : undefined,
    advancePaid: body.advancePaid != null ? Number(body.advancePaid) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const updated = await db.dieVendorOrder.update({
    where: { id },
    data: {
      ...parsed.data,
      ...(parsed.data.expectedBy !== undefined
        ? { expectedBy: parsed.data.expectedBy ? new Date(parsed.data.expectedBy) : null }
        : {}),
    },
  })
  return NextResponse.json(updated)
}
