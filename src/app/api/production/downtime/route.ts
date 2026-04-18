import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
export const dynamic = 'force-dynamic'

const postSchema = z.object({
  productionJobCardId: z.string().uuid(),
  productionStageRecordId: z.string().uuid().optional().nullable(),
  machineId: z.string().uuid().optional().nullable(),
  reasonCategory: z.enum([
    'WAITING_TOOLING',
    'WAITING_MATERIAL',
    'MECHANICAL',
    'POWER_UTILITY',
    'CHANGEOVER_SETUP',
  ]),
  /** When the idle gap began (typically last production tick). */
  gapStartedAt: z.string().min(1),
  notes: z.string().max(2000).optional().nullable(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const parsed = postSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  }

  const { productionJobCardId, productionStageRecordId, machineId, reasonCategory, gapStartedAt, notes } =
    parsed.data

  const started = new Date(gapStartedAt)
  if (Number.isNaN(started.getTime())) {
    return NextResponse.json({ error: 'Invalid gapStartedAt' }, { status: 400 })
  }

  const endedAt = new Date()
  const durationSeconds = Math.max(0, Math.floor((endedAt.getTime() - started.getTime()) / 1000))

  const jc = await db.productionJobCard.findUnique({ where: { id: productionJobCardId }, select: { id: true } })
  if (!jc) return NextResponse.json({ error: 'Job card not found' }, { status: 404 })

  const row = await db.productionDowntimeLog.create({
    data: {
      productionJobCardId,
      productionStageRecordId: productionStageRecordId ?? undefined,
      machineId: machineId ?? undefined,
      operatorUserId: user!.id,
      reasonCategory,
      startedAt: started,
      endedAt,
      durationSeconds,
      notes: notes?.trim() || null,
    },
  })

  return NextResponse.json({
    id: row.id,
    operatorUserId: row.operatorUserId,
    createdAt: row.createdAt.toISOString(),
    durationSeconds: row.durationSeconds,
  })
}
