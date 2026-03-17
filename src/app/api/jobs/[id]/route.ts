import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/audit'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateJobSchema = z.object({
  status: z.string().optional(),
  productName: z.string().min(1).optional(),
  qtyOrdered: z.number().int().positive().optional(),
  imposition: z.number().int().positive().optional(),
  machineSequence: z.array(z.string().uuid()).optional(),
  dueDate: z.string().optional(),
  specialInstructions: z.string().optional(),
})

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAuth()
  if (error) return error

  const { id } = await context.params

  const job = await db.job.findUnique({
    where: { id },
    include: {
      customer: true,
      creator: { select: { name: true, email: true } },
      closer: { select: { name: true } },
      artwork: { include: { approvals: true, uploader: { select: { name: true } } } },
      bomLines: {
        include: { material: true, machine: { select: { machineCode: true, name: true } } },
      },
      stages: {
        include: {
          machine: { select: { machineCode: true, name: true } },
          starter: { select: { name: true } },
          completer: { select: { name: true } },
        },
        orderBy: { startedAt: 'asc' },
      },
      qcRecords: { orderBy: { checkedAt: 'desc' } },
      sheetIssues: { include: { material: { select: { materialCode: true } } } },
    },
  })

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  return NextResponse.json(job)
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id } = await context.params
  const body = await req.json()
  const parsed = updateJobSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const existing = await db.job.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const { dueDate, ...rest } = parsed.data
  const data = { ...rest } as Record<string, unknown>
  if (dueDate) data.dueDate = new Date(dueDate)

  const job = await db.job.update({
    where: { id },
    data: data as Parameters<typeof db.job.update>[0]['data'],
  })

  await createAuditLog({
    userId: user!.id,
    action: 'UPDATE',
    tableName: 'jobs',
    recordId: id,
    newValue: parsed.data,
  })

  return NextResponse.json(job)
}
