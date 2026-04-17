import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonStringify } from '@/lib/safe-json'
import { humanizeToolingHubEventDetail } from '@/lib/tooling-hub-event-presentation'
import { buildDieHubTimelineSummary } from '@/lib/die-hub-timeline-narrative'
import { canonicalHubAction } from '@/lib/die-hub-events'
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
          select: {
            id: true,
            actionType: true,
            fromZone: true,
            toZone: true,
            details: true,
            operatorName: true,
            actorName: true,
            auditActionType: true,
            metadata: true,
            hubAction: true,
            eventCondition: true,
            createdAt: true,
          },
        })
      : await db.embossHubEvent.findMany({
          where: { blockId: id },
          orderBy: { createdAt: 'desc' },
          take: 500,
          select: {
            id: true,
            actionType: true,
            fromZone: true,
            toZone: true,
            details: true,
            createdAt: true,
          },
        })

  const entries = rows.map((r) => {
    const d = r.createdAt
    const timeLabel = Number.isNaN(d.getTime()) ? '—' : format(d, 'MMM d, yyyy HH:mm')
    const detail = humanizeToolingHubEventDetail(r.actionType, r.details)
    const rawDetails =
      r.details && typeof r.details === 'object' && !Array.isArray(r.details)
        ? (r.details as Record<string, unknown>)
        : null
    const fromDetails = (k: string): string | null => {
      const v = rawDetails?.[k]
      return typeof v === 'string' && v.trim() ? v.trim() : null
    }
    const dieRow =
      tool === 'die'
        ? (r as {
            operatorName?: string | null
            actorName?: string | null
            auditActionType?: string | null
            metadata?: unknown
            hubAction?: string | null
            eventCondition?: string | null
          })
        : null
    const opCol = tool === 'die' ? (dieRow?.operatorName?.trim() ?? null) : null
    const actorCol = tool === 'die' ? (dieRow?.actorName?.trim() ?? null) : null
    const performedBy =
      actorCol ||
      opCol ||
      fromDetails('returnOperatorName') ||
      fromDetails('operatorName') ||
      null
    const summaryLine =
      tool === 'die'
        ? buildDieHubTimelineSummary({
            createdAt: d,
            actorName: dieRow?.actorName ?? null,
            operatorName: dieRow?.operatorName ?? null,
            auditActionType: dieRow?.auditActionType ?? null,
            actionType: r.actionType,
            fromZone: r.fromZone,
            toZone: r.toZone,
            details: r.details,
            metadata: dieRow?.metadata ?? null,
          })
        : `${timeLabel}: ${performedBy ? `${performedBy} — ` : ''}${detail}`
    const hubActionCanon =
      tool === 'die'
        ? (dieRow?.hubAction?.trim() || canonicalHubAction(r.actionType))
        : null
    const eventConditionVal =
      tool === 'die'
        ? dieRow?.eventCondition?.trim() ||
          (typeof rawDetails?.returnCondition === 'string'
            ? rawDetails.returnCondition.trim()
            : null)
        : null
    return {
      id: r.id,
      createdAt: d.toISOString(),
      timeLabel,
      actionType: r.actionType,
      action: r.actionType.replace(/_/g, ' '),
      detail,
      summaryLine,
      performedBy,
      hubAction: hubActionCanon,
      condition: eventConditionVal,
      operatorName: performedBy,
      fromZone: r.fromZone,
      toZone: r.toZone,
      details: r.details,
      metadata: tool === 'die' ? dieRow?.metadata : undefined,
      auditActionType: tool === 'die' ? dieRow?.auditActionType : undefined,
    }
  })

  return new NextResponse(safeJsonStringify({ entries }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
