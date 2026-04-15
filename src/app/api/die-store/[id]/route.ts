// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  condition: z.string().optional(),
  status: z.string().optional(),
  storageLocation: z.string().optional().nullable(),
  compartment: z.string().optional().nullable(),
  expectedReturn: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const die = await db.dieStore.findUnique({
    where: { id },
    include: {
      issueRecords: { orderBy: { issuedAt: 'desc' } },
      maintenanceLogs: { orderBy: { performedAt: 'desc' } },
      vendorOrders: { orderBy: { orderedAt: 'desc' } },
      auditLog: { orderBy: { performedAt: 'desc' } },
    },
  })
  if (!die) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(die)
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const existing = await db.dieStore.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const updated = await db.dieStore.update({
    where: { id },
    data: {
      ...(parsed.data.condition !== undefined ? { condition: parsed.data.condition } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.storageLocation !== undefined ? { storageLocation: parsed.data.storageLocation } : {}),
      ...(parsed.data.compartment !== undefined ? { compartment: parsed.data.compartment } : {}),
      ...(parsed.data.expectedReturn !== undefined
        ? { expectedReturn: parsed.data.expectedReturn ? new Date(parsed.data.expectedReturn) : null }
        : {}),
    },
  })
  await db.dieAuditLog.create({
    data: {
      dieStoreId: id,
      dieCode: updated.dieCode,
      action: 'condition_updated',
      performedBy: user?.id ?? 'system',
      details: { before: existing, after: updated, notes: parsed.data.notes ?? null },
    },
  })
  return NextResponse.json(updated)
}
