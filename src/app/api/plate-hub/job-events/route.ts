import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'
import { humanizePlateHubEventDetail } from '@/lib/plate-hub-event-presentation'
import { format } from 'date-fns'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth()
  if (error) return error

  const requirementId = req.nextUrl.searchParams.get('requirementId')?.trim()
  const plateStoreId = req.nextUrl.searchParams.get('plateStoreId')?.trim()

  if ((requirementId ? 1 : 0) + (plateStoreId ? 1 : 0) !== 1) {
    return NextResponse.json(
      { error: 'Provide exactly one of requirementId or plateStoreId' },
      { status: 400 },
    )
  }

  const rows = await db.plateHubEvent.findMany({
    where: requirementId
      ? { plateRequirementId: requirementId }
      : { plateStoreId: plateStoreId! },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })

  const entries = rows.map((r) => {
    const d = r.createdAt
    const timeLabel = Number.isNaN(d.getTime()) ? '—' : format(d, 'MMM d, yyyy HH:mm')
    const detail = humanizePlateHubEventDetail(r.actionType, r.details)
    return {
      id: r.id,
      timeLabel,
      action: r.actionType,
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
