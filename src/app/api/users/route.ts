import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/**
 * List users by id/name for assignee dropdowns (e.g. NCR assignee).
 * Any authenticated user can call this; no masters role required.
 */
export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const list = await db.user.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })

  return NextResponse.json(list)
}
