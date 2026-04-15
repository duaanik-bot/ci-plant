import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { error } = await requireAuth()
    if (error) return error

    const { id } = await ctx.params
    if (!id?.trim()) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const card = await db.shadeCard.findUnique({
      where: { id },
      select: { id: true, shadeCode: true, productMaster: true },
    })
    if (!card) {
      return NextResponse.json({ error: 'Shade card not found' }, { status: 404 })
    }

    const events = await db.shadeCardEvent.findMany({
      where: { shadeCardId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        actionType: true,
        details: true,
        createdAt: true,
      },
    })

    const payload = {
      shadeCard: card,
      events: events.map((e) => ({
        id: e.id,
        actionType: e.actionType,
        details: e.details,
        createdAt: e.createdAt.toISOString(),
      })),
    }

    return new NextResponse(safeJsonStringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[inventory-hub/shade-cards/[id]/events GET]', e)
    return NextResponse.json({ error: 'Failed to load shade card history' }, { status: 500 })
  }
}
