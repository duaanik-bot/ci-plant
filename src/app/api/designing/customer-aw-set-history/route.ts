import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

/**
 * Latest set # from any PO line for this customer + artwork code (case-insensitive).
 */
export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const customerId = (req.nextUrl.searchParams.get('customerId') || '').trim()
  const awCode = (req.nextUrl.searchParams.get('awCode') || '').trim()
  const excludeLineId = (req.nextUrl.searchParams.get('excludeLineId') || '').trim()

  if (!customerId) {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 })
  }
  if (!awCode) {
    return NextResponse.json({ error: 'awCode is required' }, { status: 400 })
  }

  const row = await db.poLineItem.findFirst({
    where: {
      po: { customerId },
      artworkCode: { equals: awCode, mode: 'insensitive' },
      ...(excludeLineId ? { id: { not: excludeLineId } } : {}),
    },
    orderBy: { po: { updatedAt: 'desc' } },
    select: { setNumber: true, po: { select: { updatedAt: true } } },
  })

  const sn = row?.setNumber?.trim()
  if (!sn) {
    return NextResponse.json({ setNumber: null, sourcePoUpdatedAt: null })
  }

  return NextResponse.json({
    setNumber: sn,
    sourcePoUpdatedAt: row.po.updatedAt.toISOString(),
  })
}
