// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'

export const dynamic = 'force-dynamic'

const schema = z.object({
  reason: z.string().min(1),
  scrappedBy: z.string().min(1),
})

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { error, user } = await requireAuth()
  if (error) return error
  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }
  const updated = await db.dieStore.update({
    where: { id },
    data: {
      status: 'scrapped',
      condition: 'Scrapped',
      scrapReason: parsed.data.reason,
      scrappedBy: parsed.data.scrappedBy,
      scrappedAt: new Date(),
    },
  })
  await db.dieAuditLog.create({
    data: {
      dieStoreId: id,
      dieCode: updated.dieCode,
      action: 'scrapped',
      performedBy: user?.id ?? 'system',
      details: parsed.data,
    },
  })
  return NextResponse.json(updated)
}
