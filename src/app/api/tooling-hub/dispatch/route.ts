import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { safeJsonParse } from '@/lib/safe-json'
import { toolingHubDispatchBodySchema, normalizeDispatchBody } from '@/lib/tooling-hub-dispatch-schema'
import {
  buildDispatchDedupeKey,
  isRecentDuplicateDispatch,
  recordDispatchSuccess,
} from '@/lib/tooling-hub-idempotency'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const text = await req.text()
  const raw = safeJsonParse<unknown>(text, {})
  const parsed = toolingHubDispatchBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const errMsg = first
      ? `Missing or invalid field: ${first.path.join('.') || 'body'}`
      : 'Validation failed'
    return NextResponse.json(
      {
        error: errMsg,
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'body', i.message]),
        ),
      },
      { status: 400 },
    )
  }

  const data = normalizeDispatchBody(parsed.data)
  const dedupeKey = buildDispatchDedupeKey(user!.id, {
    toolType: data.toolType,
    jobCardId: data.jobCardId,
    artworkId: data.artworkId,
    setNumber: data.setNumber,
    source: data.source,
  })

  if (isRecentDuplicateDispatch(dedupeKey)) {
    return NextResponse.json({
      ok: true,
      idempotentReplay: true,
      message: 'Duplicate dispatch suppressed (within 5 seconds)',
      reference: null,
    })
  }

  const reference = `TH-${Date.now()}`
  const auditPayload = {
    ...data,
    reference,
  }

  await db.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        userId: user!.id,
        action: 'INSERT',
        tableName: 'tooling_hub_dispatch',
        recordId: data.jobCardId,
        newValue: auditPayload as object,
      },
    })
  })

  recordDispatchSuccess(dedupeKey)

  return NextResponse.json({
    ok: true,
    idempotentReplay: false,
    reference,
    ...data,
  })
}
