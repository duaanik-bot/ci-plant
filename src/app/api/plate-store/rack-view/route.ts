import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('search')?.trim() ?? ''
  const rows = await db.plateStore.findMany({
    where: q
      ? {
          OR: [
            { cartonName: { contains: q, mode: 'insensitive' } },
            { plateSetCode: { contains: q, mode: 'insensitive' } },
            { artworkCode: { contains: q, mode: 'insensitive' } },
          ],
        }
      : undefined,
    orderBy: [{ rackLocation: 'asc' }, { slotNumber: 'asc' }, { plateSetCode: 'asc' }],
  })

  const grouped = rows.reduce<Record<string, typeof rows>>((acc, row) => {
    const rack = row.rackLocation || 'UNASSIGNED'
    if (!acc[rack]) acc[rack] = []
    acc[rack].push(row)
    return acc
  }, {})

  return NextResponse.json(grouped)
}
