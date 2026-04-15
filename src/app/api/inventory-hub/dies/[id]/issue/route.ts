import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { inventoryIssueBodySchema } from '@/lib/inventory-hub-schemas'
import { issueToolToMachine } from '@/lib/inventory-hub-service'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'
import { buildIssueDedupeKey, isDuplicateIssue, recordIssueSuccess } from '@/lib/inventory-issue-idempotency'

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

    const dedupeKey = buildIssueDedupeKey(user.id, 'die', toolId)
    if (isDuplicateIssue(dedupeKey)) {
      return NextResponse.json({ ok: true, duplicate: true, message: 'Duplicate issue suppressed' })
    }

    const result = await issueToolToMachine('die', toolId, parsed.data.machineId, parsed.data.operatorUserId)
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
    return new NextResponse(safeJsonStringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[inventory-hub/dies issue]', e)
    return NextResponse.json({ error: 'Issue failed' }, { status: 500 })
  }
}
