// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const search = req.nextUrl.searchParams.get('search')?.trim() ?? ''
  const list = await db.dieStore.findMany({
    where: search
      ? {
          OR: [
            { dieCode: { contains: search, mode: 'insensitive' } },
            { cartonName: { contains: search, mode: 'insensitive' } },
          ],
        }
      : undefined,
    orderBy: [{ storageLocation: 'asc' }, { compartment: 'asc' }],
  })
  const grouped = list.reduce<Record<string, typeof list>>((acc, die) => {
    const key = die.storageLocation || 'UNASSIGNED'
    if (!acc[key]) acc[key] = []
    acc[key].push(die)
    return acc
  }, {})
  return NextResponse.json(grouped)
}
