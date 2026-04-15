import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'
import { humanizeToolingHubEventDetail } from '@/lib/tooling-hub-event-presentation'
import { format } from 'date-fns'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const tool = req.nextUrl.searchParams.get('tool')?.trim()
  const id = req.nextUrl.searchParams.get('id')?.trim()
  if (!id || (tool !== 'die' && tool !== 'emboss')) {
    return NextResponse.json({ error: 'Provide tool=die|emboss and id' }, { status: 400 })
  }

  const rows =
    tool === 'die'
      ? await db.dieHubEvent.findMany({
          where: { dyeId: id },
          orderBy: { createdAt: 'desc' },
          take: 500,
        })
      : await db.embossHubEvent.findMany({
          where: { blockId: id },
          orderBy: { createdAt: 'desc' },
          take: 500,
        })

  const entries = rows.map((r) => {
    const d = r.createdAt
    const timeLabel = Number.isNaN(d.getTime()) ? '—' : format(d, 'MMM d, yyyy HH:mm')
    const detail = humanizeToolingHubEventDetail(r.actionType, r.details)
    return {
      id: r.id,
      timeLabel,
      action: r.actionType.replace(/_/g, ' '),
      detail,
      performedBy: null as string | null,
      fromZone: r.fromZone,
      toZone: r.toZone,
    }
  })

  return new NextResponse(safeJsonStringify({ entries }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
