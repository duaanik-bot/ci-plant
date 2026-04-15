import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const checkoutSchema = z.object({
  givenBy: z.string().min(1, 'Giver is required'),
  takenBy: z.string().min(1, 'Taker is required'),
  notes: z.string().optional().nullable(),
})

const returnSchema = z.object({
  custodyLogId: z.string().uuid(),
  conditionOnReturn: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireRole('operations_head', 'md')
  if (error) return error

  const { id: blockId } = await context.params
  const body = await req.json().catch(() => ({}))

  if (body.action === 'return') {
    const parsed = returnSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed' }, { status: 400 })
    }
    const data = parsed.data
    const log = await db.embossBlockCustodyLog.update({
      where: { id: data.custodyLogId },
      data: {
        returnAt: new Date(),
        conditionOnReturn: data.conditionOnReturn?.trim() ?? null,
        notes: data.notes?.trim() ?? null,
      },
    })
    return NextResponse.json(log)
  }

  const parsed = checkoutSchema.safeParse(body)
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

  const openCustody = await db.embossBlockCustodyLog.findFirst({
    where: { blockId, returnAt: null },
  })
  if (openCustody) {
    return NextResponse.json(
      { error: 'Block is already checked out. Return it first.' },
      { status: 400 },
    )
  }

  const data = parsed.data
  const log = await db.embossBlockCustodyLog.create({
    data: {
      blockId,
      givenBy: data.givenBy.trim(),
      takenBy: data.takenBy.trim(),
      notes: data.notes?.trim() ?? null,
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'emboss_block_custody_log',
    recordId: log.id,
    newValue: { blockId, givenBy: data.givenBy, takenBy: data.takenBy },
  })

  return NextResponse.json(log, { status: 201 })
}
