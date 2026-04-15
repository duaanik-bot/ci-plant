import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { inventoryReceiveVendorBodySchema } from '@/lib/inventory-hub-schemas'
import { receiveToolFromVendor } from '@/lib/inventory-hub-service'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'
import {
  buildIssueDedupeKey,
  isDuplicateIssue,
  recordIssueSuccess,
} from '@/lib/inventory-issue-idempotency'

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
    const parsed = inventoryReceiveVendorBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const dedupeKey = buildIssueDedupeKey(user.id, 'emboss_block:vendor_receive', toolId)
    if (isDuplicateIssue(dedupeKey)) {
      return NextResponse.json({ ok: true, duplicate: true, message: 'Duplicate receive-from-vendor suppressed' })
    }

    const result = await receiveToolFromVendor('emboss_block', toolId, {
      notes: parsed.data.notes,
      condition: parsed.data.condition,
    })
    if (result.ok === false) {
      const status =
        result.code === 'NOT_FOUND' ? 404 : result.code === 'NOT_AT_VENDOR' ? 409 : 400
      return NextResponse.json({ error: result.message, code: result.code }, { status })
    }

    recordIssueSuccess(dedupeKey)
    return new NextResponse(safeJsonStringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[inventory-hub/emboss-blocks receive-from-vendor]', e)
    return NextResponse.json({ error: 'Receive from vendor failed' }, { status: 500 })
  }
}
