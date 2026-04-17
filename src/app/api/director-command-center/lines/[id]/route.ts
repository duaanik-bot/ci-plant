import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth, createAuditLog } from '@/lib/helpers'
import { DIRECTOR_AUDIT_ACTOR } from '@/lib/director-command-center-lifecycle'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  directorPriority: z.boolean().optional(),
  directorHold: z.boolean().optional(),
  directorBroadcastNote: z.string().max(4000).optional().nullable(),
})

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const existing = await db.poLineItem.findUnique({
    where: { id },
    select: { id: true, cartonName: true, directorPriority: true, directorHold: true },
  })
  if (!existing) return NextResponse.json({ error: 'Line not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const data = parsed.data
  if (
    data.directorPriority === undefined &&
    data.directorHold === undefined &&
    data.directorBroadcastNote === undefined
  ) {
    return NextResponse.json({ error: 'No changes' }, { status: 400 })
  }

  const updated = await db.poLineItem.update({
    where: { id },
    data: {
      ...(data.directorPriority !== undefined ? { directorPriority: data.directorPriority } : {}),
      ...(data.directorHold !== undefined ? { directorHold: data.directorHold } : {}),
      ...(data.directorBroadcastNote !== undefined
        ? { directorBroadcastNote: data.directorBroadcastNote?.trim() || null }
        : {}),
    },
  })

  const parts: string[] = []
  if (data.directorPriority !== undefined) {
    parts.push(
      data.directorPriority
        ? 'Priority override: Director star ON (audit trail)'
        : 'Priority override: Director star OFF (audit trail)',
    )
  }
  if (data.directorHold !== undefined) {
    parts.push(data.directorHold ? 'HOLD engaged' : 'HOLD released')
  }
  if (data.directorBroadcastNote !== undefined) {
    parts.push('Broadcast note updated')
  }

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'director_command_center',
    recordId: id,
    newValue: {
      poLineItemId: id,
      cartonName: existing.cartonName,
      changes: data,
      actorLabel: DIRECTOR_AUDIT_ACTOR,
      summary: parts.join(' · '),
    },
  })

  return NextResponse.json(updated)
}
