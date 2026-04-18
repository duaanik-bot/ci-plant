import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** Whether any carton (product master) name contains the query — for PO list empty-state UX. */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ exists: false })
  }

  const n = await db.carton.count({
    where: { cartonName: { contains: q, mode: Prisma.QueryMode.insensitive } },
  })

  return NextResponse.json({ exists: n > 0 })
}
