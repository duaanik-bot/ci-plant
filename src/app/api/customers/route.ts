import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const customers = await db.customer.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      gstNumber: true,
      contactName: true,
      contactPhone: true,
      email: true,
      address: true,
    },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(customers)
}
