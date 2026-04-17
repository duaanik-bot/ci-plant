import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { inventoryIssueBodySchema } from '@/lib/inventory-hub-schemas'
import { issueToolToMachine } from '@/lib/inventory-hub-service'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'
import { buildIssueDedupeKey, isDuplicateIssue, recordIssueSuccess } from '@/lib/inventory-issue-idempotency'
import { createEmbossHubEvent, EMBOSS_HUB_ACTION } from '@/lib/emboss-hub-events'
import { embossHubZoneLabelFromCustody, DIE_HUB_ZONE } from '@/lib/tooling-hub-zones'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { error, user } = await requireAuth()
    if (error) return error
    if (!user?.id) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

    const { id: toolId } = await context.params
    if (!toolId?.trim()) {
      return NextResponse.json({ error: 'toolId is required' }, { status: 400 })
    }

    let raw = ''
    try {
      raw = await req.text()
    } catch {
      return NextResponse.json({ error: 'Could not read request body' }, { status: 400 })
    }
    const body = safeJsonParse<Record<string, unknown>>(raw, {})
    const parsed = inventoryIssueBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const dedupeKey = buildIssueDedupeKey(user.id, 'emboss_block', toolId)
    if (isDuplicateIssue(dedupeKey)) {
      return NextResponse.json({ ok: true, duplicate: true, message: 'Duplicate issue suppressed' })
    }

    const before = await db.embossBlock.findUnique({
      where: { id: toolId },
      select: { custodyStatus: true, blockCode: true, active: true },
    })
    if (!before?.active) {
      return NextResponse.json({ error: 'Block not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const result = await issueToolToMachine(
      'emboss_block',
      toolId,
      parsed.data.machineId,
      parsed.data.operatorUserId,
      parsed.data.operatorName,
    )
    if (result.ok === false) {
      const status =
        result.code === 'NOT_FOUND'
          ? 404
          : result.code === 'BAD_MACHINE' || result.code === 'BAD_OPERATOR'
            ? 400
            : result.code === 'ALREADY_ISSUED'
              ? 409
              : 400
      return NextResponse.json({ error: result.message, code: result.code }, { status })
    }

    recordIssueSuccess(dedupeKey)

    let opLabel = parsed.data.operatorName?.trim()
    if (!opLabel && parsed.data.operatorUserId) {
      opLabel =
        (await db.user.findUnique({
          where: { id: parsed.data.operatorUserId },
          select: { name: true },
        }))?.name ?? undefined
    }

    await createEmbossHubEvent(db, {
      blockId: toolId,
      actionType: EMBOSS_HUB_ACTION.ISSUE_TO_MACHINE,
      fromZone: embossHubZoneLabelFromCustody(before.custodyStatus),
      toZone: DIE_HUB_ZONE.ON_MACHINE_FLOOR,
      details: {
        displayCode: before.blockCode,
        machineId: parsed.data.machineId,
        operatorUserId: parsed.data.operatorUserId,
        operatorName: opLabel,
      },
    })

    return new NextResponse(safeJsonStringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[inventory-hub/emboss-blocks issue]', e)
    return NextResponse.json({ error: 'Issue failed' }, { status: 500 })
  }
}
