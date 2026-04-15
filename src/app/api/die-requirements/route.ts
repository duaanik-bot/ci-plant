import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error
  const status = req.nextUrl.searchParams.get('status') ?? undefined
  const list = await db.dieRequirement.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(list)
}
