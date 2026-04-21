import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { mergeOrchestrationIntoSpec, PLANNING_FLOW } from '@/lib/orchestration-spec'

export const dynamic = 'force-dynamic'

/**
 * Bulk forward selected planning lines to the AW queue (gang-print / processing handoff).
 * Sets orchestration.awQueueHandoffAt, planningStatus → planned, and validates mix-set coating + GSM.
 */
export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = (await req.json().catch(() => ({}))) as { lineIds?: string[] }
  const lineIds = Array.isArray(body.lineIds) ? body.lineIds.filter(Boolean) : []
  if (lineIds.length === 0) {
    return NextResponse.json({ error: 'lineIds required' }, { status: 400 })
  }

  const lines = await db.poLineItem.findMany({
    where: { id: { in: lineIds } },
    select: {
      id: true,
      planningStatus: true,
      coatingType: true,
      gsm: true,
      specOverrides: true,
    },
  })

  if (lines.length !== lineIds.length) {
    return NextResponse.json({ error: 'One or more PO lines not found' }, { status: 404 })
  }

  const notPending = lines.filter((l) => l.planningStatus !== 'pending')
  if (notPending.length > 0) {
    return NextResponse.json(
      { error: 'Only pending lines can be sent to processing', ids: notPending.map((l) => l.id) },
      { status: 409 },
    )
  }

  const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()
  const coatings = new Set(lines.map((l) => norm(l.coatingType)))
  const gsms = new Set(lines.map((l) => (l.gsm != null ? String(l.gsm) : '')))
  if (coatings.size > 1 || gsms.size > 1) {
    return NextResponse.json(
      {
        error: 'Mix-Set Conflict: Coating or GSM do not match across selected rows.',
        coatings: Array.from(coatings),
        gsms: Array.from(gsms),
      },
      { status: 409 },
    )
  }

  const now = new Date().toISOString()
  const actor = user!.name ?? user!.email ?? 'planner'

  await db.$transaction(
    lines.map((line) => {
      const spec = (line.specOverrides as Record<string, unknown> | null) || {}
      const merged = mergeOrchestrationIntoSpec(spec, {
        planningFlowStatus: PLANNING_FLOW.in_progress,
        awQueueHandoffAt: now,
      })
      const specOverrides = {
        ...merged,
        planningMakeProcessingAt: now,
        planningMakeProcessingBy: actor,
      }
      return db.poLineItem.update({
        where: { id: line.id },
        data: {
          planningStatus: 'planned',
          specOverrides: specOverrides as object,
        },
      })
    }),
  )

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: lineIds.join(','),
    newValue: { makeProcessing: true, count: lineIds.length, at: now },
  })

  return NextResponse.json({ ok: true, count: lineIds.length, at: now })
}
