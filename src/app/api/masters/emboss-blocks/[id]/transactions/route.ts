import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const TYPES = ['ISSUE', 'RETURN', 'PRODUCTION', 'DESTRUCTION'] as const

const txSchema = z.object({
  type: z.enum(TYPES),
  operatorId: z.string().min(1, 'Operator is required'),
  supervisorId: z.string().min(1, 'Supervisor is required'),
  impressionsCount: z.number().int().min(0).optional().nullable(),
  condition: z.string().min(1, 'Condition is required'),
  notes: z.string().optional().nullable(),
})

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id: blockId } = await context.params
  const txs = await db.blockTransaction.findMany({
    where: { blockId },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(txs)
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id: blockId } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = txSchema.safeParse({
    ...body,
    impressionsCount: body.impressionsCount != null ? Number(body.impressionsCount) : undefined,
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

  if (data.type === 'ISSUE') {
    const lastIssue = await db.blockTransaction.findFirst({
      where: { blockId, type: 'ISSUE' },
      orderBy: { createdAt: 'desc' },
    })
    if (lastIssue) {
      const returned = await db.blockTransaction.findFirst({
        where: { blockId, type: 'RETURN', createdAt: { gt: lastIssue.createdAt } },
      })
      if (!returned) {
        return NextResponse.json(
          { error: 'Block is already issued out. Return it first.' },
          { status: 400 },
        )
      }
    }
  }

  if (data.type === 'PRODUCTION' && (data.impressionsCount == null || data.impressionsCount <= 0)) {
    return NextResponse.json(
      { error: 'Impressions count is required for production transactions', fields: { impressionsCount: 'Required' } },
      { status: 400 },
    )
  }

  const updateData: Record<string, unknown> = {}
  if (data.condition) updateData.condition = data.condition
  if (data.type === 'PRODUCTION' && data.impressionsCount) {
    updateData.impressionCount = { increment: data.impressionsCount }
  }
  if (data.type === 'DESTRUCTION') {
    updateData.active = false
    updateData.destroyedAt = new Date()
    updateData.destroyReason = data.notes ?? 'Destroyed'
    updateData.condition = 'Destroyed'
  }

  const [tx] = await db.$transaction([
    db.blockTransaction.create({
      data: {
        blockId,
        type: data.type,
        operatorId: data.operatorId,
        supervisorId: data.supervisorId,
        impressionsCount: data.impressionsCount ?? null,
        condition: data.condition,
        notes: data.notes?.trim() ?? null,
      },
    }),
    ...(Object.keys(updateData).length > 0
      ? [db.embossBlock.update({ where: { id: blockId }, data: updateData })]
      : []),
  ])

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'block_transactions',
    recordId: tx.id,
    newValue: { blockId, type: data.type },
  })

  return NextResponse.json(tx, { status: 201 })
}
