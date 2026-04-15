// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  impressions: z.number().int().min(0),
  usedOn: z.string().optional(),
  jobCardId: z.string().uuid().optional().nullable(),
  operatorName: z.string().optional().nullable(),
  conditionAfter: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
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
    impressions: body.impressions != null ? Number(body.impressions) : 0,
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
  const usedOn = data.usedOn ? new Date(data.usedOn) : new Date()

  const [log] = await db.$transaction([
    db.embossBlockUsageLog.create({
      data: {
        blockId,
        impressions: data.impressions,
        usedOn,
        jobCardId: data.jobCardId ?? null,
        operatorName: data.operatorName?.trim() ?? null,
        conditionAfter: data.conditionAfter?.trim() ?? null,
        notes: data.notes?.trim() ?? null,
      },
    }),
    db.embossBlock.update({
      where: { id: blockId },
      data: {
        impressionCount: { increment: data.impressions },
      },
    }),
  ])

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'emboss_block_usage_log',
    recordId: log.id,
    newValue: { blockId, impressions: data.impressions },
  })

  return NextResponse.json(log, { status: 201 })
}
