// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const schema = z.object({
  actionType: z.string().min(1),
  performedBy: z.string().min(1),
  vendorName: z.string().optional().nullable(),
  cost: z.number().optional().nullable(),
  conditionBefore: z.string().optional().nullable(),
  conditionAfter: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const block = await db.embossBlock.findUnique({ where: { id } })
  if (!block) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse({
    ...body,
    cost: body.cost != null ? Number(body.cost) : undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const log = await db.embossMaintenanceLog.create({
    data: {
      embossBlockId: id,
      blockCode: block.blockCode,
      actionType: parsed.data.actionType,
      performedBy: parsed.data.performedBy,
      vendorName: parsed.data.vendorName ?? null,
      cost: parsed.data.cost ?? null,
      conditionBefore: parsed.data.conditionBefore ?? null,
      conditionAfter: parsed.data.conditionAfter ?? null,
      notes: parsed.data.notes ?? null,
    },
  })
  await db.embossAuditLog.create({
    data: {
      embossBlockId: id,
      blockCode: block.blockCode,
      action: 'polished',
      performedBy: user?.id ?? 'system',
      details: parsed.data,
    },
  })
  return NextResponse.json(log)
}
