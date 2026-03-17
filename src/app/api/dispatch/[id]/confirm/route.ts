import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function PUT(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = params

  const existing = await db.dispatch.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Dispatch not found' }, { status: 404 })
  }

  const dispatchedAt = existing.dispatchedAt ?? new Date()

  const updated = await db.dispatch.update({
    where: { id },
    data: {
      status: 'dispatched',
      dispatchedAt,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'dispatches',
    recordId: id,
    oldValue: { status: existing.status },
    newValue: { status: updated.status },
  })

  return NextResponse.json(updated)
}

