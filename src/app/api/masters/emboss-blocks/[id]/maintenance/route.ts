// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  actionType: z.string().min(1, 'Action type is required'),
  performedAt: z.string().optional(),
  conditionBefore: z.string().optional().nullable(),
  conditionAfter: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  cost: z.number().optional().nullable(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id: blockId } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse({
    ...body,
    cost: body.cost != null ? Number(body.cost) : undefined,
  })
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    parsed.error.issues.forEach((i) => {
      const path = (i.path[0] as string) ?? ''
      if (path) fields[path] = i.message
    })
    return NextResponse.json({ error: 'Validation failed', fields }, { status: 400 })
  }

  const block = await db.embossBlock.findUnique({ where: { id: blockId } })
  if (!block) return NextResponse.json({ error: 'Block not found' }, { status: 404 })

  const data = parsed.data
  const performedAt = data.performedAt ? new Date(data.performedAt) : new Date()

  const updateData: { condition?: string; lastPolishedDate?: Date; polishCount?: { increment: number } } = {}
  if (data.conditionAfter != null && data.conditionAfter.trim() !== '') {
    updateData.condition = data.conditionAfter.trim()
  }
  if (data.actionType.toLowerCase().includes('polish')) {
    updateData.lastPolishedDate = performedAt
    updateData.polishCount = { increment: 1 }
  }

  const [log] = await db.$transaction([
    db.embossBlockMaintenanceLog.create({
      data: {
        blockId,
        actionType: data.actionType.trim(),
        performedBy: user!.id,
        performedAt,
        conditionBefore: data.conditionBefore?.trim() ?? null,
        conditionAfter: data.conditionAfter?.trim() ?? null,
        notes: data.notes?.trim() ?? null,
        cost: data.cost != null ? data.cost : null,
      },
    }),
    ...(Object.keys(updateData).length > 0
      ? [
          db.embossBlock.update({
            where: { id: blockId },
            data: updateData,
          }),
        ]
      : []),
  ])

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'emboss_block_maintenance_log',
    recordId: log.id,
    newValue: { blockId, actionType: data.actionType },
  })

  return NextResponse.json(log, { status: 201 })
}
