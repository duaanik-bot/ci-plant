import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { AW_PO_STATUS, type AwPoStatus } from '@/lib/aw-queue-spec'
import { releaseReservedToolingForPoLine } from '@/lib/aw-queue-release-tooling'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  action: z.enum(['manual_close', 'force_reopen']),
})

function stripClosureMeta(spec: Record<string, unknown>): Record<string, unknown> {
  const { awClosureSnapshot: _a, ...rest } = spec
  return { ...rest }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id: lineId } = await context.params
  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'action must be manual_close or force_reopen' }, { status: 400 })
  }

  const line = await db.poLineItem.findUnique({
    where: { id: lineId },
    select: { id: true, specOverrides: true },
  })
  if (!line) return NextResponse.json({ error: 'PO line not found' }, { status: 404 })

  const spec = (line.specOverrides as Record<string, unknown> | null) || {}
  const jobType = spec.jobType === 'repeat' ? 'repeat' : 'new'
  const currentStatus = (spec.awPoStatus as AwPoStatus | undefined) ?? AW_PO_STATUS.OPEN

  const actor = user!.name?.trim() || 'Operator'

  if (parsed.data.action === 'manual_close') {
    if (currentStatus === AW_PO_STATUS.CLOSED) {
      return NextResponse.json({ error: 'Line is already closed' }, { status: 409 })
    }
    const snapshot = stripClosureMeta({ ...spec })
    const nextSpec: Record<string, unknown> = {
      ...spec,
      awPoStatus: AW_PO_STATUS.CLOSED,
      awClosureSnapshot: snapshot,
      smartHandshake: {},
    }

    await db.$transaction(async (tx) => {
      await releaseReservedToolingForPoLine(tx, {
        poLineItemId: lineId,
        actorName: actor,
        reason: 'manual_close',
      })
      await tx.poLineItem.update({
        where: { id: lineId },
        data: { specOverrides: nextSpec as object },
      })
    })

    await createAuditLog({
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'po_line_items',
      recordId: lineId,
      newValue: { awLifecycle: 'manual_close' } as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true, awPoStatus: AW_PO_STATUS.CLOSED })
  }

  /* force_reopen */
  if (jobType !== 'repeat') {
    return NextResponse.json(
      { error: 'Force reopen is only available for repeat product lines.' },
      { status: 409 },
    )
  }
  if (currentStatus !== AW_PO_STATUS.CLOSED) {
    return NextResponse.json({ error: 'Line is not closed' }, { status: 409 })
  }
  const snap = spec.awClosureSnapshot
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    return NextResponse.json({ error: 'No closure snapshot to restore' }, { status: 409 })
  }

  const snapRec = snap as Record<string, unknown>
  const { awClosureSnapshot: _c, ...restSnap } = snapRec
  const restored: Record<string, unknown> = {
    ...restSnap,
    awPoStatus: AW_PO_STATUS.REOPENED,
  }

  await db.poLineItem.update({
    where: { id: lineId },
    data: { specOverrides: restored as object },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'po_line_items',
    recordId: lineId,
    newValue: { awLifecycle: 'force_reopen' } as Record<string, unknown>,
  })

  return NextResponse.json({ ok: true, awPoStatus: AW_PO_STATUS.REOPENED })
}
