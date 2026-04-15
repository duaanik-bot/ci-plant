import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/**
 * Resolves artwork UUID for this PO line from job context: artwork.filename matches AW code
 * for the same customer as the PO (latest by version / createdAt).
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const code = (req.nextUrl.searchParams.get('code') || '').trim()
  if (!code) {
    return NextResponse.json({ artworkId: null })
  }

  const li = await db.poLineItem.findUnique({
    where: { id },
    include: { po: { select: { customerId: true } } },
  })
  if (!li) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const customerId = li.po.customerId

  const artwork = await db.artwork.findFirst({
    where: {
      filename: { equals: code, mode: 'insensitive' },
      job: { customerId },
    },
    orderBy: [{ versionNumber: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  })

  return NextResponse.json({ artworkId: artwork?.id ?? null })
}
