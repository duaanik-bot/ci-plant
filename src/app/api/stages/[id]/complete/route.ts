import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  qtyIn: z.number().int().min(0).optional(),
  qtyOut: z.number().int().min(0).optional(),
  qtyWaste: z.number().int().min(0).default(0),
  notes: z.string().optional(),
})

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const parsed = bodySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const stage = await db.jobStage.findUnique({
    where: { id },
    include: { job: true },
  })
  if (!stage) return NextResponse.json({ error: 'Stage not found' }, { status: 404 })
  if (stage.completedAt) {
    return NextResponse.json({ error: 'Stage already completed' }, { status: 400 })
  }

  const { qtyIn, qtyOut, qtyWaste, notes } = parsed.data

  await db.jobStage.update({
    where: { id },
    data: {
      completedBy: user!.id,
      completedAt: new Date(),
      qtyIn: qtyIn ?? stage.qtyIn,
      qtyOut: qtyOut ?? stage.qtyOut,
      qtyWaste: qtyWaste ?? stage.qtyWaste,
      notes,
    },
  })
  if (qtyOut != null && qtyOut > 0) {
    await db.job.update({
      where: { id: stage.jobId },
      data: { qtyProducedGood: { increment: qtyOut } },
    })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'job_stages',
    recordId: id,
    newValue: { completed: true, qtyOut, qtyWaste },
  })

  const updated = await db.jobStage.findUnique({
    where: { id },
    include: { job: { select: { jobNumber: true } } },
  })
  return NextResponse.json(updated)
}
