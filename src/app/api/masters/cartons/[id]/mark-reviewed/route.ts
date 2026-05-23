import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'
import { createAuditLog } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * POST — clear the `source` flag on a carton. Used after an operator has
 * verified an AI-imported master so the "AI imported" badge stops showing.
 * No-op (returns ok) if the row already has source = null.
 */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole('admin', 'plant_head')
  if (error) return error

  const { id } = await context.params
  if (!id?.trim()) {
    return NextResponse.json({ error: 'Carton id required' }, { status: 400 })
  }

  const existing = await db.carton.findUnique({
    where: { id },
    select: { id: true, source: true, cartonName: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (existing.source == null) {
    return NextResponse.json({ ok: true, alreadyReviewed: true, source: null })
  }

  const updated = await db.carton.update({
    where: { id },
    data: { source: null },
    select: { id: true, source: true },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'cartons',
    recordId: id,
    oldValue: { source: existing.source },
    newValue: { source: null, reviewedAt: new Date().toISOString() },
  })

  return NextResponse.json({ ok: true, source: updated.source })
}
