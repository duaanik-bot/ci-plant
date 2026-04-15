import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.plateRequirement.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })

  const updated = await db.plateRequirement.update({
    where: { id },
    data: { status: 'fulfilled' },
  })

  await db.auditLog.create({
    data: {
      userId: user?.id,
      action: 'UPDATE',
      tableName: 'plate_requirements',
      recordId: id,
      oldValue: { status: existing.status },
      newValue: { status: updated.status },
    },
  })

  return NextResponse.json(updated)
}
