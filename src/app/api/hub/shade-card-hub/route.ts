import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { queryShadeCardHubRows } from '@/lib/shade-card-hub-rows'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const rows = await queryShadeCardHubRows(q)

  return NextResponse.json({ rows })
}
