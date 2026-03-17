import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  jobId: z.string().uuid(),
  machineId: z.string().uuid(),
  stageNumber: z.number().int().positive(),
})

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'jobId, machineId, stageNumber required', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { jobId, machineId, stageNumber } = parsed.data

  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { bomLines: { include: { material: true } } },
  })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const existing = await db.jobStage.findFirst({
    where: { jobId, machineId, completedAt: null },
  })
  if (existing) {
    return NextResponse.json(
      { error: 'This machine already has an active stage for another job' },
      { status: 400 }
    )
  }

  const stage = await db.jobStage.create({
    data: {
      jobId,
      machineId,
      stageNumber,
      startedBy: user!.id,
      startedAt: new Date(),
    },
    include: {
      job: { select: { jobNumber: true, productName: true, qtyOrdered: true } },
      machine: { select: { machineCode: true, name: true } },
    },
  })

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'job_stages',
    recordId: stage.id,
    newValue: { jobId, machineId, stageNumber },
  })

  return NextResponse.json(stage, { status: 201 })
}
