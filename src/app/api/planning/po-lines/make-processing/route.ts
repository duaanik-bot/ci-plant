import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { mergeOrchestrationIntoSpec, PLANNING_FLOW } from '@/lib/orchestration-spec'
import { readPlanningMeta } from '@/lib/planning-decision-spec'
import { checkGangCompat, type GangCompatLine } from '@/lib/gang-compat'

export const dynamic = 'force-dynamic'

/**
 * Bulk forward selected planning lines to the AW queue (gang-print / processing handoff).
 * Sets orchestration.awQueueHandoffAt, planningStatus → design_ready, and validates mix-set
 * compatibility (boardType, coating, GSM, printSide = hard blocks; sheetSize, press,
 * deliveryTimeline = soft warnings).
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
      paperType: true,
      specOverrides: true,
      po: {
        select: { deliveryRequiredBy: true },
      },
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

  // Build GangCompatLine[] and check compatibility
  const now = Date.now()
  const gangLines: GangCompatLine[] = lines.map((l) => {
    const spec = (l.specOverrides as Record<string, unknown> | null) ?? {}
    const meta = readPlanningMeta(spec)
    // deliveryDays: days from now until delivery deadline (null if unset)
    const deliveryDays =
      l.po.deliveryRequiredBy != null
        ? Math.max(0, Math.round((new Date(l.po.deliveryRequiredBy).getTime() - now) / 86400000))
        : null
    return {
      id: l.id,
      boardType: (l.paperType as string | null) ?? null,
      gsm: l.gsm != null ? Number(l.gsm) : null,
      coating: (l.coatingType as string | null) ?? null,
      // printSide lives in meta.printSide (set by planner), fallback to top-level spec key
      printSide: (meta.printSide as string | null) ?? (spec.printSide as string | null) ?? null,
      // sheetSize: meta.parentSize string (e.g. "760x1020") set by sheet-spec helper
      sheetSize: (meta.parentSize as string | null) ?? null,
      deliveryDays,
      // press/machine: machineId stored directly on spec root (from production schedule board)
      press: (spec.machineId as string | null) ?? null,
    }
  })

  const compatResult = checkGangCompat(gangLines)

  if (!compatResult.ok) {
    const conflictFields = compatResult.conflicts.map((c) => c.field).join(', ')
    return NextResponse.json(
      {
        error: `Mix-Set Conflict: ${conflictFields} do not match across selected rows.`,
        conflicts: compatResult.conflicts,
      },
      { status: 409 },
    )
  }

  const nowIso = new Date().toISOString()
  const actor = user!.name ?? user!.email ?? 'planner'

  await db.$transaction(
    lines.map((line) => {
      const spec = (line.specOverrides as Record<string, unknown> | null) || {}
      const merged = mergeOrchestrationIntoSpec(spec, {
        planningFlowStatus: PLANNING_FLOW.in_progress,
        awQueueHandoffAt: nowIso,
      })
      const specOverrides = {
        ...merged,
        planningMakeProcessingAt: nowIso,
        planningMakeProcessingBy: actor,
      }
      return db.poLineItem.update({
        where: { id: line.id },
        data: {
          planningStatus: 'design_ready',
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
    newValue: { makeProcessing: true, count: lineIds.length, at: nowIso },
  })

  const response: Record<string, unknown> = { ok: true, count: lineIds.length, at: nowIso }
  if (compatResult.warnings.length > 0) {
    response.warnings = compatResult.warnings
  }
  return NextResponse.json(response)
}
