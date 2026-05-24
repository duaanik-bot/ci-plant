import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  try {
    const candidates = await db.poLineItem.findMany({
      where: {
        planningStatus: 'pending',
        id: { not: id },
      },
      select: {
        id: true,
        quantity: true,
        cartonName: true,
        coatingType: true,
        gsm: true,
        paperType: true,
        specOverrides: true,
        po: {
          select: {
            poNumber: true,
            deliveryRequiredBy: true,
          },
        },
      },
      take: 50,
    })

    return NextResponse.json({ candidates })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
