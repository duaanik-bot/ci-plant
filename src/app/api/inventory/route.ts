import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export async function GET() {
  const { error } = await requireAuth()
  if (error) return error

  const items = await db.inventory.findMany({
    orderBy: { materialCode: 'asc' },
  })
  return NextResponse.json(items)
}
