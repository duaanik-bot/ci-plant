import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import {
  canonicalHubAction,
  DIE_HUB_ACTION,
  DIE_HUB_AUDIT_ACTION,
} from '@/lib/die-hub-events'
import { EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import {
  dieHubCustodyFromEventZone,
  dieHubZoneLabelFromCustody,
  embossHubCustodyFromEventZone,
} from '@/lib/tooling-hub-zones'
import { CUSTODY_ON_FLOOR } from '@/lib/inventory-hub-custody'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  tool: z.enum(['die', 'emboss']),
  id: z.string().uuid(),
  actorName: z.string().min(1).max(120),
})

function httpError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number }
  e.status = status
  return e
}

function restoredCustodyFromEvent(
  tool: 'die' | 'emboss',
  fromZone: string | null,
  details: unknown,
): string | null {
  const map = tool === 'die' ? dieHubCustodyFromEventZone : embossHubCustodyFromEventZone
  const z = map(fromZone)
  if (z) return z
  const d = details && typeof details === 'object' ? (details as Record<string, unknown>) : null
  const rs = d?.restoredStatus
  return typeof rs === 'string' && rs.trim() ? rs.trim() : null
}

/** Pop the latest non-superseded hub event and restore prior custody (die: append UNDO row; emboss: legacy delete). */
export async function POST(req: NextRequest) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: 'tool, id, and actorName are required' }, { status: 400 })
    }
    const { tool, id, actorName } = parsed.data
    const actor = actorName.trim()
    const now = new Date()

    let returnedToTechnicalSpecs = false

    if (tool === 'die') {
      const result = await db.$transaction(async (tx) => {
        const row = await tx.dye.findUnique({ where: { id } })
        if (!row?.active) throw httpError(404, 'Die not found')

        const events = await tx.dieHubEvent.findMany({
          where: { dyeId: id, supersededByUndoEventId: null },
          orderBy: { createdAt: 'desc' },
        })
        if (!events.length) throw httpError(409, 'No hub history to reverse')

        const last = events[0]!
        const onlyOne = events.length === 1
        if (
          onlyOne &&
          (last.actionType === DIE_HUB_ACTION.PUSH_TO_TRIAGE ||
            last.actionType === DIE_HUB_ACTION.MANUAL_VENDOR_CREATE ||
            last.actionType === DIE_HUB_ACTION.MANUAL_LIVE_CREATE)
        ) {
          await tx.dye.delete({ where: { id } })
          return { returnedToTechnicalSpecs: true }
        }

        const prevCustody = restoredCustodyFromEvent('die', last.fromZone ?? null, last.details)
        if (!prevCustody) throw httpError(409, 'Cannot reverse — unknown prior zone')

        const decReuse = last.actionType === DIE_HUB_ACTION.RETURN_TO_RACK
        const nextReuse = decReuse ? Math.max(0, row.reuseCount - 1) : row.reuseCount

        const clearIssue = prevCustody !== CUSTODY_ON_FLOOR

        const currentZoneLabel = dieHubZoneLabelFromCustody(row.custodyStatus)
        const previousZoneLabel = dieHubZoneLabelFromCustody(prevCustody)
        const narrative = `${actor} reversed the last action. Tool moved from ${currentZoneLabel} back to ${previousZoneLabel}.`

        await tx.dye.update({
          where: { id },
          data: {
            custodyStatus: prevCustody,
            hubPreviousCustody: null,
            hubCustodySource: null,
            reuseCount: nextReuse,
            ...(clearIssue
              ? { issuedMachineId: null, issuedOperator: null, issuedAt: null }
              : {}),
            ...(last.actionType === DIE_HUB_ACTION.RETURN_TO_RACK
              ? { hubStatusFlag: null, hubPoorReportedBy: null }
              : {}),
            updatedAt: now,
          },
        })

        const undo = await tx.dieHubEvent.create({
          data: {
            dyeId: id,
            actionType: DIE_HUB_ACTION.HUB_UNDO_LAST,
            fromZone: currentZoneLabel,
            toZone: previousZoneLabel,
            actorName: actor,
            operatorName: actor,
            auditActionType: DIE_HUB_AUDIT_ACTION.UNDO,
            hubAction: canonicalHubAction(DIE_HUB_ACTION.HUB_UNDO_LAST),
            metadata: {
              condition: null,
              remarks: narrative,
              currentZoneLabel,
              previousZoneLabel,
              reversedEventId: last.id,
              reversedActionType: last.actionType,
            } as object,
            details: {
              displayCode: `DYE-${row.dyeNumber}`,
              reversedEventId: last.id,
              reversedActionType: last.actionType,
              narrative,
            } as object,
          },
        })

        await tx.dieHubEvent.update({
          where: { id: last.id },
          data: { supersededByUndoEventId: undo.id },
        })

        return { returnedToTechnicalSpecs: false }
      })
      returnedToTechnicalSpecs = result.returnedToTechnicalSpecs
    } else {
      const result = await db.$transaction(async (tx) => {
        const row = await tx.embossBlock.findUnique({ where: { id } })
        if (!row?.active) throw httpError(404, 'Block not found')

        const events = await tx.embossHubEvent.findMany({
          where: { blockId: id },
          orderBy: { createdAt: 'desc' },
        })
        if (!events.length) throw httpError(409, 'No hub history to reverse')

        const last = events[0]!
        const onlyOne = events.length === 1
        if (
          onlyOne &&
          (last.actionType === EMBOSS_HUB_ACTION.PUSH_TO_TRIAGE ||
            last.actionType === EMBOSS_HUB_ACTION.MANUAL_ENGRAVING_CREATE)
        ) {
          await tx.embossBlock.delete({ where: { id } })
          return { returnedToTechnicalSpecs: true }
        }

        const prevCustody = restoredCustodyFromEvent('emboss', last.fromZone ?? null, last.details)
        if (!prevCustody) throw httpError(409, 'Cannot reverse — unknown prior zone')

        const decReuse = last.actionType === EMBOSS_HUB_ACTION.RETURN_TO_RACK
        const nextReuse = decReuse ? Math.max(0, row.reuseCount - 1) : row.reuseCount
        const clearIssue = prevCustody !== CUSTODY_ON_FLOOR

        await tx.embossBlock.update({
          where: { id },
          data: {
            custodyStatus: prevCustody,
            hubPreviousCustody: null,
            reuseCount: nextReuse,
            ...(clearIssue
              ? { issuedMachineId: null, issuedOperator: null, issuedAt: null }
              : {}),
            updatedAt: now,
          },
        })
        await tx.embossHubEvent.delete({ where: { id: last.id } })
        return { returnedToTechnicalSpecs: false }
      })
      returnedToTechnicalSpecs = result.returnedToTechnicalSpecs
    }

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: tool === 'die' ? 'dyes' : 'emboss_blocks',
      recordId: id,
      newValue: {
        toolingHubReverseLast: true,
        tool,
        actorName: actor,
      } as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true, returnedToTechnicalSpecs })
  } catch (e: unknown) {
    if (e instanceof Error && 'status' in e && typeof (e as Error & { status: number }).status === 'number') {
      const ex = e as Error & { status: number }
      return NextResponse.json({ error: ex.message }, { status: ex.status })
    }
    console.error('[tooling-hub/reverse-last]', e)
    return NextResponse.json({ error: 'Reverse failed' }, { status: 500 })
  }
}
