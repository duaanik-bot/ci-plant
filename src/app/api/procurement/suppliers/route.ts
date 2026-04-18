import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Active suppliers for procurement workbench (any authenticated user). */
export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const list = await db.supplier.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      materialTypes: true,
      defaultForBoardGrades: true,
      leadTimeDays: true,
      paymentTermsDays: true,
      email: true,
      contactPhone: true,
    },
  })
  return NextResponse.json(list)
}
