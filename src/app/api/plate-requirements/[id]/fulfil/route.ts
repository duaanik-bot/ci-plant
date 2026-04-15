import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { mergeOrchestrationIntoSpec, PLATE_FLOW } from '@/lib/orchestration-spec'

export const dynamic = 'force-dynamic'

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const existing = await db.plateRequirement.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.plateRequirement.update({
      where: { id },
      data: { status: 'fulfilled' },
    })

    const poLineId = existing.poLineId?.trim()
    if (poLineId) {
      const line = await tx.poLineItem.findUnique({
        where: { id: poLineId },
        select: { specOverrides: true },
      })
      const spec = (line?.specOverrides as Record<string, unknown> | null) || {}
      await tx.poLineItem.update({
        where: { id: poLineId },
        data: {
          specOverrides: mergeOrchestrationIntoSpec(spec, {
            plateFlowStatus: PLATE_FLOW.ready_inventory,
          }) as object,
        },
      })
    }

    return u
  })

  await db.auditLog.create({
    data: {
      userId: user!.id,
      action: 'UPDATE',
      tableName: 'plate_requirements',
      recordId: id,
      oldValue: { status: existing.status },
      newValue: { status: updated.status },
    },
  })

  return NextResponse.json(updated)
}
