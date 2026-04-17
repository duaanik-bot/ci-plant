import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const rows = await db.auditLog.findMany({
    where: {
      tableName: 'director_command_center',
      recordId: id,
    },
    orderBy: { timestamp: 'desc' },
    take: 80,
    select: {
      id: true,
      action: true,
      newValue: true,
      userId: true,
      timestamp: true,
    },
  })

  return NextResponse.json(rows)
}
