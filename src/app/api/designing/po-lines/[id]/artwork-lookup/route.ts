import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/** True if another PO line already uses this artwork code (repeat job). */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const code = (req.nextUrl.searchParams.get('code') || '').trim()
  if (!code) {
    return NextResponse.json({ repeat: false })
  }

  const existing = await db.poLineItem.findFirst({
    where: {
      id: { not: id },
      artworkCode: { equals: code, mode: 'insensitive' },
    },
    select: { id: true },
  })

  return NextResponse.json({ repeat: !!existing })
}
