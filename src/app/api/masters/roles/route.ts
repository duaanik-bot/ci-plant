import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'

export async function GET() {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const roles = await db.role.findMany({
    select: { id: true, roleName: true },
    orderBy: { roleName: 'asc' },
  })
  return NextResponse.json(roles)
}
